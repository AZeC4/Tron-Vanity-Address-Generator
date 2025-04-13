const TronWeb = require('tronweb');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');

// 全局配置变量
const VANITY_DIGITS = 5; // 修改这个值来设置您想要的靓号位数 (3, 4, 5, 6等)
const RESULT_FILENAME = 'number.txt';
const REPORT_INTERVAL = 5000; // 报告间隔（毫秒）
const DEBUG_MODE = true; // 调试模式，打印更多信息

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

// 格式化时间函数
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 函数：检查地址是否以指定后缀结尾
function checkAddress(address, suffix) {
  if (!address || typeof address !== 'string') return false;
  
  // 调试信息，检查地址格式
  if (DEBUG_MODE && process.pid % 8 === 0) {
    // 只在一个工作进程中打印，避免日志过多
    console.log(`检查地址: ${address} 是否以 ${suffix} 结尾`);
  }
  
  try {
    // 移除地址前缀"T"并检查后缀
    const baseAddress = address.substring(1); 
    return baseAddress.toLowerCase().endsWith(suffix.toLowerCase());
  } catch (e) {
    console.error('检查地址出错:', e);
    return false;
  }
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
    
    // 确保地址有效
    if (!address || typeof address !== 'string' || !address.startsWith('T')) {
      if (DEBUG_MODE) {
        console.error(`生成了无效地址: ${address}`);
      }
      return { privateKey: '', address: '' };
    }
    
    return { privateKey, address };
  } catch (error) {
    console.error('生成账户时出错:', error);
    return { privateKey: '', address: '' };
  }
}

// 函数：将结果追加到单个文件
function saveToFile(address, privateKey, suffix, stats = null) {
  let content = '';
  
  // 如果提供了统计信息，添加时间戳和运行统计
  if (stats) {
    const { elapsedTime, foundCount, attempts, rate } = stats;
    const timestamp = new Date().toLocaleString();
    const formattedTime = formatTime(elapsedTime);
    
    content += `=== 搜索统计 ===\n`;
    content += `时间戳: ${timestamp}\n`;
    content += `搜索后缀: ${suffix}\n`;
    content += `总运行时间: ${formattedTime}\n`;
    content += `总尝试次数: ${attempts.toLocaleString()}\n`;
    content += `平均速度: ${rate.toLocaleString()} 地址/秒\n`;
    content += `找到地址数量: ${foundCount}\n\n`;
  }
  
  content += `Address: ${address}\n==========\nPrivate Key: ${privateKey}\n\n`;
  
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
      process.send({ found: true, address, privateKey, attempts });
      
      // 继续搜索，重置计数
      attempts = 0;
    }
    
    // 报告进度
    if (attempts % reportInterval === 0) {
      process.send({ 
        found: false, 
        attempts,
        pid: process.pid
      });
      
      // 重置计数，避免数值过大或累积不准确
      attempts = 0;
    }
  }
}

// 主进程逻辑
if (cluster.isPrimary) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log(`\n===== 波场靓号地址生成器 =====`);
  console.log(`当前设置：${VANITY_DIGITS}位数靓号\n`);
  
  rl.question(`请输入${VANITY_DIGITS}位数的波场地址后缀: `, (suffix) => {
    if (suffix.length !== VANITY_DIGITS) {
      console.log(`错误: 后缀必须恰好为${VANITY_DIGITS}个字符。`);
      rl.close();
      process.exit(1);
    }

    rl.question('请输入要查找的地址数量 (输入0表示无限制): ', (targetCount) => {
      const targetAddressCount = parseInt(targetCount, 10);
      
      // 记录开始时间
      const startTime = Date.now();
      const startDateTime = new Date().toLocaleString();
      
      console.log(`\n开始时间: ${startDateTime}`);
      console.log(`正在搜索以 ${suffix} 结尾的波场地址...`);
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
      let lastReportTime = Date.now();
      let lastReportAttempts = 0;
      
      // 设置定时器定期显示统计信息
      const statsInterval = setInterval(() => {
        const elapsedTime = (Date.now() - startTime) / 1000;
        const currentTime = Date.now();
        const timeWindow = (currentTime - lastReportTime) / 1000; // 计算时间窗口（秒）
        
        // 计算即时速率（最近5秒的速率）
        const instantRate = Math.floor((totalAttempts - lastReportAttempts) / timeWindow);
        
        // 计算平均速率
        const averageRate = Math.floor(totalAttempts / elapsedTime);
        
        // 更新上次报告数据
        lastReportTime = currentTime;
        lastReportAttempts = totalAttempts;
        
        const formattedTime = formatTime(elapsedTime);
        console.log(`运行时间: ${formattedTime} | 已搜索: ${totalAttempts.toLocaleString()} 个地址 | 即时速率: ${instantRate.toLocaleString()}/秒 | 平均: ${averageRate.toLocaleString()}/秒 | 已找到: ${foundAddressCount}`);
      }, REPORT_INTERVAL);
      
      // 监听来自工作进程的消息
      cluster.on('message', (worker, message) => {
        if (message.found) {
          foundAddressCount++;
          
          // 更新总尝试次数
          if (message.attempts) {
            totalAttempts += message.attempts;
          }
          
          // 获取当前统计信息
          const elapsedTime = (Date.now() - startTime) / 1000;
          const rate = Math.floor(totalAttempts / elapsedTime);
          
          // 保存结果但不终止工作进程
          saveToFile(message.address, message.privateKey, suffix);
          
          // 检查是否已达到目标
          if (targetAddressCount > 0 && foundAddressCount >= targetAddressCount) {
            const endTime = Date.now();
            const totalElapsedTime = (endTime - startTime) / 1000;
            const formattedTotalTime = formatTime(totalElapsedTime);
            
            console.log(`\n已达到${targetAddressCount}个地址的目标。正在停止...`);
            console.log(`总运行时间: ${formattedTotalTime}`);
            clearInterval(statsInterval);
            
            // 追加总结统计信息到文件
            const summaryStats = {
              elapsedTime: totalElapsedTime,
              foundCount: foundAddressCount,
              attempts: totalAttempts,
              rate: Math.floor(totalAttempts / totalElapsedTime)
            };
            
            fs.appendFileSync(resultsFile, `\n=== 搜索完成 ===\n搜索后缀: ${suffix}\n总运行时间: ${formattedTotalTime}\n总尝试次数: ${totalAttempts.toLocaleString()}\n总找到地址: ${foundAddressCount}\n平均速度: ${summaryStats.rate.toLocaleString()} 地址/秒\n开始时间: ${startDateTime}\n结束时间: ${new Date().toLocaleString()}\n\n`);
            
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
        const endTime = Date.now();
        const totalElapsedTime = (endTime - startTime) / 1000;
        const formattedTotalTime = formatTime(totalElapsedTime);
        const rate = Math.floor(totalAttempts / totalElapsedTime);
        
        console.log('\n正在优雅地关闭...');
        console.log(`总运行时间: ${formattedTotalTime}`);
        clearInterval(statsInterval);
        
        // 追加总结统计信息到文件
        fs.appendFileSync(resultsFile, `\n=== 搜索被中断 ===\n搜索后缀: ${suffix}\n总运行时间: ${formattedTotalTime}\n总尝试次数: ${totalAttempts.toLocaleString()}\n总找到地址: ${foundAddressCount}\n平均速度: ${rate.toLocaleString()} 地址/秒\n开始时间: ${startDateTime}\n结束时间: ${new Date().toLocaleString()}\n\n`);
        
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