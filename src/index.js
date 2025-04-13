const TronWeb = require('tronweb');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');

// 全局配置变量
const VANITY_DIGITS = 6; // 修改这个值来设置您想要的靓号位数 (3, 4, 5, 6等)
const RESULT_FILENAME = 'number.txt';

// 初始化TronWeb
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io'
});

// 确保结果文件存在
const resultsDir = path.join(__dirname, '..');
const resultsFile = path.join(resultsDir, RESULT_FILENAME);

// 如果结果文件不存在，则创建它
if (!fs.existsSync(resultsFile)) {
  fs.writeFileSync(resultsFile, '');
}

// 函数：检查地址是否以指定后缀结尾
function checkAddress(address, suffix) {
  if (!address) return false;
  
  // 移除地址前缀"T"并检查后缀
  const baseAddress = address.substring(1); 
  return baseAddress.toLowerCase().endsWith(suffix.toLowerCase());
}

// 函数：生成随机私钥
function generateRandomPrivateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// 函数：从私钥生成波场账户
function generateAccount() {
  try {
    // 生成随机私钥
    const privateKey = generateRandomPrivateKey();
    
    // 使用TronWeb从私钥生成地址
    const address = tronWeb.address.fromPrivateKey(privateKey);
    
    return { privateKey, address };
  } catch (error) {
    console.error('生成账户时出错:', error);
    return { privateKey: '', address: '' };
  }
}

// 函数：将结果追加到单个文件
function saveToFile(address, privateKey) {
  const content = `Address: ${address}\n==========\nPrivate Key: ${privateKey}\n\n`;
  
  fs.appendFileSync(resultsFile, content);
  console.log(`\n成功！找到地址: ${address}`);
  console.log(`结果已保存至: ${resultsFile}`);
}

// 工作进程的主函数
function workerProcess(suffix) {
  console.log(`工作进程 ${process.pid} 开始搜索...`);
  
  let attempts = 0;
  const reportInterval = 10000;
  
  while (true) {
    attempts++;
    
    // 生成新的随机账户
    const { address, privateKey } = generateAccount();
    
    // 检查地址是否符合条件
    if (address && checkAddress(address, suffix)) {
      // 将结果发送回主进程
      process.send({ found: true, address, privateKey });
      
      // 继续搜索
      attempts = 0;
    }
    
    // 报告进度
    if (attempts % reportInterval === 0) {
      process.send({ 
        found: false, 
        attempts,
        pid: process.pid
      });
    }
  }
}

// 主进程逻辑
if (cluster.isPrimary) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question(`请输入${VANITY_DIGITS}位数的波场地址后缀: `, (suffix) => {
    if (suffix.length !== VANITY_DIGITS) {
      console.log(`错误: 后缀必须恰好为${VANITY_DIGITS}个字符。`);
      rl.close();
      process.exit(1);
    }

    rl.question('请输入要查找的地址数量 (输入0表示无限制): ', (targetCount) => {
      const targetAddressCount = parseInt(targetCount, 10);
      
      console.log(`\n正在搜索以 ${suffix} 结尾的波场地址...`);
      if (targetAddressCount > 0) {
        console.log(`找到${targetAddressCount}个地址后将自动停止`);
      } else {
        console.log('将持续运行直到手动停止 (按Ctrl+C)');
      }
      
      // 获取CPU核心数
      const numCores = os.cpus().length;
      console.log(`使用${numCores}个CPU核心进行并行处理\n`);
      
      let totalAttempts = 0;
      let foundAddressCount = 0;
      let startTime = Date.now();
      
      // 设置定时器定期显示统计信息
      const statsInterval = setInterval(() => {
        const elapsedTime = (Date.now() - startTime) / 1000;
        const rate = Math.floor(totalAttempts / elapsedTime);
        console.log(`已搜索 ${totalAttempts.toLocaleString()} 个地址 (${rate.toLocaleString()}/秒) | 已找到: ${foundAddressCount}`);
      }, 5000);
      
      // 监听来自工作进程的消息
      cluster.on('message', (worker, message) => {
        if (message.found) {
          foundAddressCount++;
          
          // 保存结果但不终止工作进程
          saveToFile(message.address, message.privateKey);
          
          // 检查是否已达到目标
          if (targetAddressCount > 0 && foundAddressCount >= targetAddressCount) {
            console.log(`\n已达到${targetAddressCount}个地址的目标。正在停止...`);
            clearInterval(statsInterval);
            
            // 终止所有工作进程
            Object.values(cluster.workers).forEach(worker => {
              worker.kill();
            });
            
            rl.close();
            process.exit(0);
          }
        } else {
          // 更新总尝试次数
          totalAttempts += message.attempts;
        }
      });
      
      // 处理优雅终止
      process.on('SIGINT', () => {
        console.log('\n正在优雅地关闭...');
        clearInterval(statsInterval);
        
        // 终止所有工作进程
        Object.values(cluster.workers).forEach(worker => {
          worker.kill();
        });
        
        console.log(`总共找到地址: ${foundAddressCount}`);
        console.log(`所有结果已保存至: ${resultsFile}`);
        process.exit(0);
      });
      
      // 为每个CPU创建工作进程
      for (let i = 0; i < numCores; i++) {
        const worker = cluster.fork();
        worker.send({ suffix });
      }
      
      rl.close();
    });
  });
} else {
  // 这是工作进程
  process.on('message', (message) => {
    if (message.suffix) {
      workerProcess(message.suffix);
    }
  });
} 