const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 数据缓存 =====
let dataHistory = [];

// ===== 历史记录存储 =====
let historyRecords = [];
let historyIdCounter = 0;

// ===== 首页 =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 接收 ESP32 数据 =====
app.post('/data', (req, res) => {
  const pt = req.body;
  pt.expected = pt.expected || 0;
  pt.diff = pt.diff || 0;
  pt.currentPoint = pt.currentPoint || 0;
  pt.totalPoints = pt.totalPoints || 0;

  dataHistory.push(pt);
  io.emit('scanPoint', pt);
  console.log('收到数据:', pt.angle, pt.z);
  res.send('ok');
});

// ===== HTTP AI 分析接口 =====
app.post('/analyze', async (req, res) => {
  try {
    const { dataPoints } = req.body;
    if (!dataPoints || dataPoints.length === 0) {
      return res.status(400).json({ error: '数据为空' });
    }
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

    const aiReply = response.data.choices[0].message.content;
    res.json({ analysis: aiReply });
  } catch (error) {
    console.error('AI 分析失败:', error.message);
    res.status(500).json({ error: 'AI 分析失败: ' + error.message });
  }
});

// ===== 清除历史数据 =====
app.get('/clear', (req, res) => {
  dataHistory = [];
  console.log('历史数据已清除');
  res.send('ok');
});

// ===== 保存本轮数据（兼容末尾斜杠） =====
app.post(['/save', '/save/'], (req, res) => {
  const { timestamp, pass1Data, pass2Data } = req.body;
  const record = {
    id: ++historyIdCounter,
    timestamp: timestamp || new Date().toISOString(),
    pass1Data,
    pass2Data
  };
  historyRecords.push(record);
  console.log(`保存第${record.id}条记录，时间:${record.timestamp}`);
  res.json({ success: true, id: record.id });
});

// ===== 获取历史记录列表 =====
app.get('/history', (req, res) => {
  const list = historyRecords.map(r => ({ id: r.id, timestamp: r.timestamp }));
  res.json(list);
});

// ===== 获取某条记录的详细数据 =====
app.get('/history/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const record = historyRecords.find(r => r.id === id);
  if (!record) return res.status(404).json({ error: '未找到' });
  res.json(record);
});

// ===== Socket.IO 连接处理 =====
io.on('connection', (socket) => {
  console.log('App 已连接');

  // 发送历史数据
  if (dataHistory.length > 0) {
    console.log(`发送 ${dataHistory.length} 条历史数据`);
    dataHistory.forEach(pt => {
      socket.emit('scanPoint', pt);
    });
  }

  // 控制指令
  socket.on('togglePower', () => {});
  socket.on('setDirection', () => {});

  // AI 分析（通过 Socket.IO）
  socket.on('analyze', async (data) => {
    try {
      const { dataPoints } = data;
      if (!dataPoints || dataPoints.length === 0) {
        socket.emit('analyzeResult', { error: '数据为空' });
        return;
      }
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

      const aiReply = response.data.choices[0].message.content;
      socket.emit('analyzeResult', { analysis: aiReply });
    } catch (error) {
      console.error('AI 分析失败:', error.message);
      socket.emit('analyzeResult', { error: 'AI 分析失败: ' + error.message });
    }
  });

  socket.emit('stateUpdate', { power: false, direction: 'forward' });
});

// ===== 启动服务器 =====
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
});