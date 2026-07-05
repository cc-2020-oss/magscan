const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const dgram = require('dgram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 数据缓存 =====
let dataHistory = [];
let historyRecords = [];
let historyIdCounter = 0;

// 自动保存周期相关
let currentPass1 = [];
let currentPass2 = [];
let lastPass = 0;
let lastAngle = 0;

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 接收 ESP32 数据
app.post('/data', (req, res) => {
  const pt = req.body;
  pt.expected = pt.expected || 0;
  pt.diff = pt.diff || 0;
  pt.currentPoint = pt.currentPoint || 0;
  pt.totalPoints = pt.totalPoints || 0;
  dataHistory.push(pt);
  io.emit('scanPoint', pt);

  // ===== 自动收集周期数据 =====
  if (pt.pass === 1) {
    if (lastPass === 2 && lastAngle <= 0 && pt.angle > 0) {
      currentPass1 = [];
      currentPass2 = [];
    }
    currentPass1.push({
      angle: pt.angle, x: pt.x, y: pt.y, z: pt.z, mag: pt.mag, diff: pt.diff, anomaly: pt.anomaly
    });
  } else if (pt.pass === 2) {
    currentPass2.push({
      angle: pt.angle, x: pt.x, y: pt.y, z: pt.z, mag: pt.mag, diff: pt.diff, anomaly: pt.anomaly
    });
    if (pt.angle <= 5 && lastPass === 2 && lastAngle > pt.angle) {
      saveCycle();
      currentPass1 = [];
      currentPass2 = [];
    }
  }

  lastPass = pt.pass;
  lastAngle = pt.angle;

  console.log('收到数据:', pt.angle, pt.z);
  res.send('ok');
});

function saveCycle() {
  // 正向数据点少于100个，说明扫描未完成，不保存
  if (currentPass1.length < 100 || currentPass2.length === 0) {
    console.log('周期不完整，跳过保存 (正向点数:' + currentPass1.length + ', 反向点数:' + currentPass2.length + ')');
    return;
  }

  const record = {
    id: ++historyIdCounter,
    timestamp: new Date().toLocaleString(),
    pass1Data: {
      p1X: currentPass1.map(p => [p.angle, p.x]),
      p1Y: currentPass1.map(p => [p.angle, p.y]),
      p1Z: currentPass1.map(p => [p.angle, p.z]),
      p1Mag: currentPass1.map(p => [p.angle, p.mag]),
      p1Diff: currentPass1.map(p => [p.angle, p.diff])
    },
    pass2Data: {
      p2X: currentPass2.map(p => [p.angle, p.x]),
      p2Y: currentPass2.map(p => [p.angle, p.y]),
      p2Z: currentPass2.map(p => [p.angle, p.z]),
      p2Mag: currentPass2.map(p => [p.angle, p.mag]),
      p2Diff: currentPass2.map(p => [p.angle, p.diff])
    }
  };
  historyRecords.push(record);
  
  // 限制最多保留20组记录，超过则删除最旧的一组
  if (historyRecords.length > 20) {
    historyRecords.shift();
  }
  
  console.log(`自动保存周期记录 ID: ${record.id}, 当前总记录数: ${historyRecords.length}`);
  io.emit('newHistoryRecord', { id: record.id, timestamp: record.timestamp });
}

// AI 分析接口（HTTP）
app.post('/analyze', async (req, res) => {
  try {
    const { dataPoints } = req.body;
    if (!dataPoints || dataPoints.length === 0) return res.status(400).json({ error: '数据为空' });
    const recent = dataPoints.slice(-100);
    const angles = recent.map(p => p.angle);
    const zValues = recent.map(p => p.z);
    const maxZ = Math.max(...zValues);
    const minZ = Math.min(...zValues);
    const avgZ = (zValues.reduce((a, b) => a + b, 0) / zValues.length).toFixed(2);
    const prompt = `我有一段磁场扫描数据（Z轴分量），共${recent.length}个点，角度范围${angles[0]}°到${angles[angles.length - 1]}°，Z值最大${maxZ}，最小${minZ}，平均值${avgZ}。请分析可能存在的异常或损伤，并给出建议。`;
    const response = await axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: 'qwen-max',
        messages: [
          { role: 'system', content: '你是一个磁场无损检测专家。' },
          { role: 'user', content: prompt }
        ]
      },
      {
        headers: {
          'Authorization': 'Bearer sk-ws-H.RPPPMIL.POIl.MEYCIQDAySfphNDsgJuKrBeJAo-dOJPIA81TryR4EL0jORjVCAIhAPorx-WVPuJtk09fCTO0-DwCsD3CcLdNJdOlyPJzDgJk',
          'Content-Type': 'application/json'
        }
      }
    );
    res.json({ analysis: response.data.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: 'AI 分析失败: ' + error.message });
  }
});

// 清除数据
app.get('/clear', (req, res) => { dataHistory = []; res.send('ok'); });

// 历史记录列表
app.get('/history', (req, res) => {
  res.json(historyRecords.map(r => ({ id: r.id, timestamp: r.timestamp })));
});

// 历史记录详情
app.get('/history/:id', (req, res) => {
  const record = historyRecords.find(r => r.id === parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: '未找到' });
  res.json(record);
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('App 已连接');
  if (dataHistory.length > 0) dataHistory.forEach(pt => socket.emit('scanPoint', pt));
  socket.on('togglePower', () => {});
  socket.on('setDirection', () => {});
  socket.on('analyze', async (data) => {
    try {
      const { dataPoints } = data;
      if (!dataPoints || dataPoints.length === 0) { socket.emit('analyzeResult', { error: '数据为空' }); return; }
      const recent = dataPoints.slice(-100);
      const angles = recent.map(p => p.angle);
      const zValues = recent.map(p => p.z);
      const maxZ = Math.max(...zValues);
      const minZ = Math.min(...zValues);
      const avgZ = (zValues.reduce((a, b) => a + b, 0) / zValues.length).toFixed(2);
      const prompt = `我有一段磁场扫描数据（Z轴分量），共${recent.length}个点，角度范围${angles[0]}°到${angles[angles.length - 1]}°，Z值最大${maxZ}，最小${minZ}，平均值${avgZ}。请分析可能存在的异常或损伤，并给出建议。`;
      const response = await axios.post(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        {
          model: 'qwen-max',
          messages: [
            { role: 'system', content: '你是一个磁场无损检测专家。' },
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Authorization': 'Bearer sk-ws-H.RPPPMIL.POIl.MEYCIQDAySfphNDsgJuKrBeJAo-dOJPIA81TryR4EL0jORjVCAIhAPorx-WVPuJtk09fCTO0-DwCsD3CcLdNJdOlyPJzDgJk',
            'Content-Type': 'application/json'
          }
        }
      );
      socket.emit('analyzeResult', { analysis: response.data.choices[0].message.content });
    } catch (error) {
      socket.emit('analyzeResult', { error: 'AI 分析失败: ' + error.message });
    }
  });
  socket.emit('stateUpdate', { power: false, direction: 'forward' });
});

// ===== UDP 广播发现服务 =====
const UDP_PORT = 3001;
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${PORT}`);
});