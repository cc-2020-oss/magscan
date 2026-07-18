const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const dgram = require('dgram');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 历史数据持久化文件路径 =====
const HISTORY_FILE = path.join(__dirname, 'history_data.json');
const MAX_HISTORY_RECORDS = 50;

// ===== 数据缓存 =====
const MAX_DATA_HISTORY = 2000;
let dataHistory = [];
let historyRecords = [];
let historyIdCounter = 0;
let lastDevicePostTime = 0;
let lastDeviceIP = null;

// ===== 历史数据持久化 =====
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      historyRecords = saved.records || [];
      historyIdCounter = saved.idCounter || 0;
      console.log(`[持久化] 已加载 ${historyRecords.length} 条历史记录`);
    }
  } catch (e) {
    console.log('[持久化] 加载失败，使用空历史:', e.message);
  }
}

function saveHistory() {
  const data = JSON.stringify({
    records: historyRecords,
    idCounter: historyIdCounter
  }, null, 2);
  fs.writeFile(HISTORY_FILE, data, 'utf-8', (err) => {
    if (err) console.log('[持久化] 保存失败:', err.message);
  });
}

// 自动保存周期相关
let currentScanData = [];
let lastCompleteScanData = [];  // 最近一次完整扫描数据的副本，供 AI 分析使用
let scanNearEnd = false;
let scanMaxDist = 0;
let scanReturning = false;
let scanTimeoutTimer = null;
const SCAN_MAX = 133.33;
const SCAN_NEAR_END = SCAN_MAX - 2;
const MAX_CURRENT_SCAN_POINTS = 2000;
const SCAN_TIMEOUT_MS = 30000;

// AI API Key
const DEFAULT_AI_KEY = process.env.AI_API_KEY || 'sk-ws-H.RPPPMIL.POIl.MEYCIQDAySfphNDsgJuKrBeJAo-dOJPIA81TryR4EL0jORjVCAIhAPorx-WVPuJtk09fCTO0-DwCsD3CcLdNJdOlyPJzDgJk';
let currentAIKey = DEFAULT_AI_KEY;
let currentModelName = '默认模型';

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 接收 ESP32 数据（新格式：distance, x1, y1, z1, t1, mag1, x2, y2, z2, t2, mag2）
function sanitizeNum(v, min, max) {
  const n = Number(v);
  return (isFinite(n) && n >= min && n <= max) ? n : 0;
}

app.post('/data', (req, res) => {
  const pt = req.body || {};
  pt.distance = sanitizeNum(pt.distance, 0, 500);
  pt.x1 = sanitizeNum(pt.x1, -100000, 100000);
  pt.y1 = sanitizeNum(pt.y1, -100000, 100000);
  pt.z1 = sanitizeNum(pt.z1, -100000, 100000);
  pt.t1 = sanitizeNum(pt.t1, -40, 125);
  pt.ang1 = sanitizeNum(pt.ang1, -360, 360);
  pt.mag1 = sanitizeNum(pt.mag1, 0, 100000);
  pt.x2 = sanitizeNum(pt.x2, -100000, 100000);
  pt.y2 = sanitizeNum(pt.y2, -100000, 100000);
  pt.z2 = sanitizeNum(pt.z2, -100000, 100000);
  pt.t2 = sanitizeNum(pt.t2, -40, 125);
  pt.ang2 = sanitizeNum(pt.ang2, -360, 360);
  pt.mag2 = sanitizeNum(pt.mag2, 0, 100000);
  lastDevicePostTime = Date.now();
  lastDeviceIP = req.ip;

  // 使用 ESP32 发送的 sessionId 和 totalPoints（优先），否则服务端估算
  pt.sessionId = (pt.sessionId != null) ? pt.sessionId : 0;
  if (!pt.totalPoints || pt.totalPoints <= 0) {
    pt.totalPoints = Math.ceil(SCAN_MAX / 0.16);
  }
  pt.currentPoint = currentScanData.length + 1;

  // 如果正在回退阶段，不广播也不记录到扫描数据
  if (scanReturning) {
    if (pt.distance <= 1) {
      scanReturning = false;
      scanMaxDist = pt.distance;
      scanNearEnd = false;
    }
    res.send('ok');
    return;
  }

  dataHistory.push(pt);
  if (dataHistory.length > MAX_DATA_HISTORY) {
    dataHistory.splice(0, dataHistory.length - MAX_DATA_HISTORY);
  }
  io.emit('scanPoint', pt);

  // 更新扫描过程中达到的最大距离
  if (pt.distance > scanMaxDist) {
    scanMaxDist = pt.distance;
  }

  // 标记是否接近扫描终点
  if (pt.distance >= SCAN_NEAR_END) {
    scanNearEnd = true;
  }

  // ===== 单程扫描自动保存 =====
  // 触发1: 从最大距离累计回退超过5mm，说明扫描完成，进入回退阶段
  if (scanNearEnd && scanMaxDist - pt.distance > 5) {
    saveCycle();
    currentScanData = [];
    scanNearEnd = false;
    scanMaxDist = 0;
    scanReturning = true;
    res.send('ok');
    return;
  }

  // 触发2: 新扫描周期开始（距离从高位跳变到低位）
  if (scanMaxDist > SCAN_MAX - 3 && pt.distance <= 1) {
    saveCycle();
    currentScanData = [];
    scanNearEnd = false;
    scanMaxDist = 0;
    scanReturning = false;
  }

  if (currentScanData.length >= MAX_CURRENT_SCAN_POINTS) {
    console.log('[警告] 当前扫描数据超过上限，强制保存并清空');
    saveCycle();
    currentScanData = [];
    scanNearEnd = false;
    scanMaxDist = 0;
  }
  currentScanData.push({
    distance: pt.distance,
    x1: pt.x1, y1: pt.y1, z1: pt.z1, t1: pt.t1, ang1: pt.ang1, mag1: pt.mag1,
    x2: pt.x2, y2: pt.y2, z2: pt.z2, t2: pt.t2, ang2: pt.ang2, mag2: pt.mag2
  });

  // 重置超时定时器
  if (scanTimeoutTimer) clearTimeout(scanTimeoutTimer);
  scanTimeoutTimer = setTimeout(() => {
    if (currentScanData.length >= 50) {
      console.log('[超时] 扫描超时自动保存，点数:', currentScanData.length);
      saveCycle();
      currentScanData = [];
      scanNearEnd = false;
      scanMaxDist = 0;
      scanReturning = false;
    }
  }, SCAN_TIMEOUT_MS);

  console.log('收到数据: 距离=', pt.distance, 'Z1=', pt.z1, 'Z2=', pt.z2, '点数=', currentScanData.length);
  res.send('ok');
});

// 强制保存当前扫描数据（手动触发）
app.post('/force-save', (req, res) => {
  if (currentScanData.length < 50) {
    return res.json({ ok: false, msg: '数据不足' });
  }
  saveCycle();
  currentScanData = [];
  scanNearEnd = false;
  scanMaxDist = 0;
  scanReturning = false;
  if (scanTimeoutTimer) clearTimeout(scanTimeoutTimer);
  res.json({ ok: true, msg: '已保存' });
});

function saveCycle() {
  if (currentScanData.length < 50) {
    console.log('扫描数据不足，跳过保存 (点数:' + currentScanData.length + ')');
    return;
  }

  // 保存副本供 AI 分析使用（在 currentScanData 被清空前）
  lastCompleteScanData = currentScanData.slice();

  const X1 = [], Y1 = [], Z1 = [], T1 = [], Ang1 = [], Mag1 = [];
  const X2 = [], Y2 = [], Z2 = [], T2 = [], Ang2 = [], Mag2 = [];
  for (const p of currentScanData) {
    const d = p.distance;
    X1.push([d, p.x1]); Y1.push([d, p.y1]); Z1.push([d, p.z1]);
    T1.push([d, p.t1]); Ang1.push([d, p.ang1]); Mag1.push([d, p.mag1]);
    X2.push([d, p.x2]); Y2.push([d, p.y2]); Z2.push([d, p.z2]);
    T2.push([d, p.t2]); Ang2.push([d, p.ang2]); Mag2.push([d, p.mag2]);
  }
  const record = {
    id: ++historyIdCounter,
    timestamp: new Date().toLocaleString(),
    pointCount: currentScanData.length,
    distRange: `${currentScanData[0].distance.toFixed(1)} ~ ${currentScanData[currentScanData.length - 1].distance.toFixed(1)} mm`,
    data: { X1, Y1, Z1, T1, Ang1, Mag1, X2, Y2, Z2, T2, Ang2, Mag2 }
  };
  historyRecords.push(record);
  
  if (historyRecords.length > MAX_HISTORY_RECORDS) {
    historyRecords.shift();
  }
  
  saveHistory();
  if (scanTimeoutTimer) { clearTimeout(scanTimeoutTimer); scanTimeoutTimer = null; }
  console.log(`自动保存周期记录 ID: ${record.id}, 点数: ${record.pointCount}, 总记录数: ${historyRecords.length}`);
  io.emit('newHistoryRecord', { id: record.id, timestamp: record.timestamp, pointCount: record.pointCount });
}

// AI 分析公共函数：构建 prompt 并调用阿里云 API
async function analyzeData(dataPoints) {
  if (!currentAIKey) {
    throw new Error('AI API Key 未配置，请在 AI 设置中配置 Key');
  }

  const channels = ['x1','y1','z1','t1','ang1','mag1','x2','y2','z2','t2','ang2','mag2'];
  const distances = dataPoints.map(p => p.distance);
  const stats = {};

  channels.forEach(ch => {
    const vals = dataPoints.map(p => p[ch] != null ? p[ch] : 0);
    stats[ch] = {
      max: Math.max(...vals).toFixed(2),
      min: Math.min(...vals).toFixed(2),
      avg: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
    };
  });

  const prompt =
`我有一段双传感器十二通道磁探伤（MFL）扫描数据，共${dataPoints.length}个点，扫描距离范围${distances[0].toFixed(2)}mm 到${distances[distances.length - 1].toFixed(2)}mm。

【传感器1 数据统计】
  X1磁通量: 最大值${stats.x1.max}uT  最小值${stats.x1.min}uT  平均值${stats.x1.avg}uT
  Y1磁通量: 最大值${stats.y1.max}uT  最小值${stats.y1.min}uT  平均值${stats.y1.avg}uT
  Z1磁通量: 最大值${stats.z1.max}uT  最小值${stats.z1.min}uT  平均值${stats.z1.avg}uT
  T1温度:   最大值${stats.t1.max}°C    最小值${stats.t1.min}°C    平均值${stats.t1.avg}°C
  Ang1角度: 最大值${stats.ang1.max}°   最小值${stats.ang1.min}°   平均值${stats.ang1.avg}°
  Mag1合磁通量: 最大值${stats.mag1.max}uT  最小值${stats.mag1.min}uT  平均值${stats.mag1.avg}uT

【传感器2 数据统计】
  X2磁通量: 最大值${stats.x2.max}uT  最小值${stats.x2.min}uT  平均值${stats.x2.avg}uT
  Y2磁通量: 最大值${stats.y2.max}uT  最小值${stats.y2.min}uT  平均值${stats.y2.avg}uT
  Z2磁通量: 最大值${stats.z2.max}uT  最小值${stats.z2.min}uT  平均值${stats.z2.avg}uT
  T2温度:   最大值${stats.t2.max}°C    最小值${stats.t2.min}°C    平均值${stats.t2.avg}°C
  Ang2角度: 最大值${stats.ang2.max}°   最小值${stats.ang2.min}°   平均值${stats.ang2.avg}°
  Mag2合磁通量: 最大值${stats.mag2.max}uT  最小值${stats.mag2.min}uT  平均值${stats.mag2.avg}uT

请从以下维度进行专业磁探伤分析：
1. 根据Z轴磁通量（主磁场方向）的突变点和峰值位置，判断可能存在的缺陷类型（裂纹、气孔、腐蚀、夹杂、磨损等）及其严重程度；
2. 根据X/Y轴磁通量的异常波动，识别漏磁场分布特征，定位缺陷的精确距离范围；
3. 对比双传感器（传感器1和传感器2）的数据差异，判断缺陷是否贯穿或偏向某一侧；
4. 根据合磁通量Mag的变化趋势，评估材料整体磁性能的均匀性；
5. 结合角度数据Ang，判断磁场方向是否发生异常偏转，辅助确认缺陷位置；
6. 给出综合评估结论和后续检测建议。`;

  const response = await axios.post(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      model: 'qwen-max',
      messages: [
        { role: 'system', content: '你是一名精通磁探伤（MFL）检测的资深工程师，擅长分析双传感器磁场扫描数据，能够根据磁通量变化识别材料内部缺陷（裂纹、气孔、腐蚀、夹杂等），评估损伤严重程度并给出专业检测建议。' },
        { role: 'user', content: prompt }
      ]
    },
    {
      headers: {
        'Authorization': 'Bearer ' + currentAIKey,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

// AI 分析接口（HTTP）
app.post('/analyze', async (req, res) => {
  try {
    const { dataPoints } = req.body;
    if (!dataPoints || dataPoints.length === 0) return res.status(400).json({ error: '数据为空' });
    const result = await analyzeData(dataPoints);
    res.json({ analysis: result });
  } catch (error) {
    res.status(500).json({ error: 'AI 分析失败: ' + error.message });
  }
});

// 清除数据
app.get('/clear', (req, res) => {
  dataHistory = [];
  currentScanData = [];
  lastCompleteScanData = [];
  scanNearEnd = false;
  scanMaxDist = 0;
  scanReturning = false;
  if (scanTimeoutTimer) { clearTimeout(scanTimeoutTimer); scanTimeoutTimer = null; }
  res.send('ok');
});

// ESP32 心跳（保持在线状态）
app.post('/heartbeat', (req, res) => {
  if (lastDeviceIP && req.ip !== lastDeviceIP) {
    return res.status(403).send('forbidden');
  }
  lastDevicePostTime = Date.now();
  res.send('ok');
});

// 设备连接状态（ESP32 是否在线）
app.get('/device-status', (req, res) => {
  const now = Date.now();
  const elapsed = now - lastDevicePostTime;
  const online = lastDevicePostTime > 0 && elapsed < 15000;
  res.json({ online, lastSeen: lastDevicePostTime, elapsed });
});

// 历史记录列表
app.get('/history', (req, res) => {
  res.json(historyRecords.map(r => ({
    id: r.id, timestamp: r.timestamp, pointCount: r.pointCount, distRange: r.distRange
  })));
});

// 历史记录详情
app.get('/history/:id', (req, res) => {
  const record = historyRecords.find(r => r.id === parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: '未找到' });
  res.json(record);
});

// 清除所有历史记录
app.delete('/history/clear', (req, res) => {
  const count = historyRecords.length;
  historyRecords = [];
  historyIdCounter = 0;
  saveHistory();
  res.json({ message: '已清除', count });
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('App 已连接');
  if (currentScanData.length > 0) {
    const replayPoints = currentScanData.map((p, i) => ({
      ...p,
      currentPoint: i + 1,
      totalPoints: currentScanData.length
    }));
    replayPoints.forEach(pt => socket.emit('scanPoint', pt));
  }

  socket.emit('modelInfo', { modelName: currentModelName });

  socket.on('getModelInfo', () => {
    socket.emit('modelInfo', { modelName: currentModelName });
  });

  socket.on('setApiKey', (data) => {
    const key = (data && data.key) ? String(data.key).trim() : '';
    if (!key) {
      socket.emit('modelInfo', { error: 'Key 不能为空', modelName: currentModelName });
      return;
    }
    if (!key.startsWith('sk-')) {
      socket.emit('modelInfo', { error: 'Key 格式不正确，应以 sk- 开头', modelName: currentModelName });
      return;
    }
    currentAIKey = key;
    currentModelName = (data && data.modelName) ? String(data.modelName).trim() : '自定义模型';
    console.log('[AI] 已切换到: ' + currentModelName);
    socket.emit('modelInfo', { modelName: currentModelName });
  });

  socket.on('resetApiKey', () => {
    currentAIKey = DEFAULT_AI_KEY;
    currentModelName = '默认模型';
    console.log('[AI] 已恢复默认模型');
    socket.emit('modelInfo', { modelName: currentModelName });
  });
  socket.on('analyze', async (data) => {
    try {
      let dataPoints = (data && data.dataPoints) ? data.dataPoints : null;
      if (!dataPoints || dataPoints.length === 0) {
        if (currentScanData.length > 0) {
          dataPoints = currentScanData;
          console.log(`[AI分析] 使用当前扫描数据，共 ${dataPoints.length} 个点`);
        } else if (lastCompleteScanData.length > 0) {
          dataPoints = lastCompleteScanData;
          console.log(`[AI分析] 使用上一轮完整扫描数据，共 ${dataPoints.length} 个点`);
        } else {
          socket.emit('analyzeResult', { error: '暂无扫描数据，请先完成一轮扫描' });
          return;
        }
      }
      const result = await analyzeData(dataPoints);
      socket.emit('analyzeResult', { analysis: result });
    } catch (error) {
      socket.emit('analyzeResult', { error: 'AI 分析失败: ' + error.message });
    }
  });
  socket.emit('stateUpdate', { power: false, direction: 'forward' });
});

const PORT = process.env.PORT || 3000;

// ===== UDP 广播发现服务 =====
const UDP_PORT = (parseInt(PORT) || 3000) + 1;
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('message', (msg, rinfo) => {
  if (msg.toString() === 'magscan-discover') {
    const reply = Buffer.from(`magscan-server:${PORT}`);
    udpSocket.send(reply, rinfo.port, rinfo.address);
    console.log(`回复广播给 ${rinfo.address}`);
  }
});
udpSocket.bind(UDP_PORT, '0.0.0.0', () => {
  console.log(`UDP 发现服务监听端口 ${UDP_PORT}`);
});

if (currentAIKey.startsWith('sk-')) {
  console.log('[提示] 使用内置 AI API Key（默认模型），AI分析功能已就绪');
} else {
  console.log('[警告] currentAIKey 格式可能不正确，AI分析可能不可用');
}

loadHistory();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${PORT}`);
});