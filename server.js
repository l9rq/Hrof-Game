const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// خدمة الملفات الثابتة من المجلد الرئيسي
app.use(express.static(__dirname));

// توجيهات ذكية لصفحة البداية والمقدم والجرس (بـ .html وبدونها)
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.get('/host', (req, res) => { res.sendFile(path.join(__dirname, 'host.html')); });
app.get('/host.html', (req, res) => { res.sendFile(path.join(__dirname, 'host.html')); });

app.get('/buzzer', (req, res) => { res.sendFile(path.join(__dirname, 'buzzer.html')); });
app.get('/buzzer.html', (req, res) => { res.sendFile(path.join(__dirname, 'buzzer.html')); });

// تحميل الأسئلة من نفس المجلد الرئيسي
let baseQuestions = {};
try {
  const questionsPath = path.join(__dirname, 'questions.json');
  if (fs.existsSync(questionsPath)) {
    const data = fs.readFileSync(questionsPath, 'utf8');
    JSON.parse(data).forEach(q => {
      if (!baseQuestions[q.letter]) baseQuestions[q.letter] = [];
      baseQuestions[q.letter].push(q);
    });
    console.log('✅ تم تحميل الأسئلة بنجاح!');
  } else {
    console.error('⚠️ تحذير: ملف questions.json غير موجود في المجلد الرئيسي.');
  }
} catch (e) { 
  console.error('⚠️ خطأ في قراءة ملف الأسئلة:', e.message); 
}

const defaultSettings = {
  competitionName: 'اسمك', team1Name: 'الفريق الأول', team2Name: 'الفريق الثاني',
  team1Color: '#12b49c', team2Color: '#f37021', hostMode: 'auto', winPoints: 1, gameStarted: false,
  ansTime: 5, otherTeamTime: 10
};

const rooms = new Map();
const roomIntervals = new Map();

function generateRoomID() { return crypto.randomBytes(4).toString('hex'); }

function createRoom(customSettings = {}) {
  const roomID = generateRoomID();
  
  // تحويل نصوص الوقت والنقاط إلى أرقام برمجية لتجنب تعليق المؤقت
  if (customSettings.ansTime !== undefined) customSettings.ansTime = parseInt(customSettings.ansTime) || 5;
  if (customSettings.otherTeamTime !== undefined) customSettings.otherTeamTime = parseInt(customSettings.otherTeamTime) || 10;
  if (customSettings.winPoints !== undefined) customSettings.winPoints = parseInt(customSettings.winPoints) || 1;

  const settings = { ...defaultSettings, ...customSettings };
  const gameState = {
    cells: generateCells(Object.keys(baseQuestions)),
    currentCellIndex: null, currentQuestion: null, currentAnswer: null,
    questionActive: false, scores: [0, 0], roundOver: false, highlightedCellIndex: null,
    buzzerLocked: false, buzzerWinner: null, timerPhase: null, timeLeft: 0
  };
  rooms.set(roomID, { settings, gameState });
  return roomID;
}

function generateCells(letters) { return letters.sort(() => 0.5 - Math.random()).slice(0, 25).map(letter => ({ letter, color: null })); }

function resetBoard(room) {
  room.gameState.cells = generateCells(Object.keys(baseQuestions));
  room.gameState.currentCellIndex = null; room.gameState.currentQuestion = null; room.gameState.currentAnswer = null;
  room.gameState.questionActive = false; room.gameState.roundOver = false; room.gameState.highlightedCellIndex = null;
  resetBuzzerState(room.settings.roomID, room);
}

function resetBuzzerState(roomID, room) {
  if (roomIntervals.has(roomID)) { clearInterval(roomIntervals.get(roomID)); }
  room.gameState.buzzerLocked = false; room.gameState.buzzerWinner = null; 
  room.gameState.timerPhase = null; room.gameState.timeLeft = 0;
}

function checkWin(gameState, teamColor, mode) {
  const size = 5, cells = gameState.cells, tColor = teamColor.toLowerCase().trim();
  let grid = [];
  for (let i = 0; i < size; i++) grid[i] = cells.slice(i * size, (i + 1) * size);
  let visited = Array(size).fill().map(() => Array(size).fill(false));
  let queue = [];
  if (mode === 'vertical') {
    for (let c = 0; c < size; c++) if (grid[0][c].color && grid[0][c].color.toLowerCase().trim() === tColor) { queue.push([0, c]); visited[0][c] = true; }
  } else {
    for (let r = 0; r < size; r++) if (grid[r][0].color && grid[r][0].color.toLowerCase().trim() === tColor) { queue.push([r, 0]); visited[r][0] = true; }
  }
  while (queue.length) {
    let [r, c] = queue.shift();
    if (mode === 'vertical' && r === size - 1) return true;
    if (mode === 'horizontal' && c === size - 1) return true;
    let neighbors = [[r, c - 1], [r, c + 1]];
    if (r % 2 === 0) neighbors.push([r - 1, c - 1], [r - 1, c], [r + 1, c - 1], [r + 1, c]);
    else neighbors.push([r - 1, c], [r - 1, c + 1], [r + 1, c], [r + 1, c + 1]);
    for (let [nr, nc] of neighbors) {
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && !visited[nr][nc] && grid[nr][nc].color && grid[nr][nc].color.toLowerCase().trim() === tColor) {
        visited[nr][nc] = true; queue.push([nr, nc]);
      }
    }
  }
  return false;
}

io.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong'));

  socket.on('create-room', (customSettings) => {
    const roomID = createRoom(customSettings);
    rooms.get(roomID).settings.roomID = roomID;
    socket.join(roomID); socket.roomID = roomID; socket.isHost = true;
    const room = rooms.get(roomID);
    room.settings.gameStarted = true;
    socket.emit('room-created', { roomID });
    socket.emit('game-state', room.gameState);
    socket.emit('settings', room.settings);
  });

  socket.on('join-room', ({ roomID, playerName }) => {
    const room = rooms.get(roomID);
    if (!room) return socket.emit('error', 'الغرفة غير موجودة');
    socket.join(roomID); socket.roomID = roomID; socket.playerName = playerName;
    socket.emit('game-state', room.gameState);
    socket.emit('settings', room.settings);
  });

  socket.on('request-game-state', () => {
    const room = rooms.get(socket.roomID);
    if (room) { socket.emit('game-state', room.gameState); socket.emit('settings', room.settings); }
  });

  socket.on('update-settings', (newSettings) => {
    const room = rooms.get(socket.roomID);
    if (!room || !socket.isHost) return;
    
    // تأكيد تحويل الأرقام عند التحديث
    if (newSettings.ansTime !== undefined) newSettings.ansTime = parseInt(newSettings.ansTime) || 5;
    if (newSettings.otherTeamTime !== undefined) newSettings.otherTeamTime = parseInt(newSettings.otherTeamTime) || 10;
    if (newSettings.winPoints !== undefined) newSettings.winPoints = parseInt(newSettings.winPoints) || 1;
    
    room.settings = { ...room.settings, ...newSettings };
    io.to(socket.roomID).emit('settings', room.settings);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomID);
    if (!room || !socket.isHost) return;
    room.settings.gameStarted = true;
    resetBoard(room); room.gameState.scores = [0,0];
    io.to(socket.roomID).emit('settings', room.settings);
    io.to(socket.roomID).emit('game-state', room.gameState);
    io.to(socket.roomID).emit('buzzer-reset');
  });

  socket.on('press-buzzer', (playerData) => {
    const room = rooms.get(socket.roomID);
    // 🚨 التعديل الأهم: منع ضغط الجرس إذا لم يتم اختيار حرف أو لم يكن هناك سؤال فعّال
    if (!room || room.gameState.buzzerLocked || !room.gameState.questionActive) return;
    
    room.gameState.buzzerLocked = true;
    room.gameState.buzzerWinner = playerData;
    room.gameState.timerPhase = 'answer';
    room.gameState.timeLeft = room.settings.ansTime;
    
    io.to(socket.roomID).emit('buzzer-locked', { winner: playerData, timeLeft: room.gameState.timeLeft, phase: 'answer' });
    io.to(socket.roomID).emit('game-state', room.gameState);
    
    if (roomIntervals.has(socket.roomID)) { clearInterval(roomIntervals.get(socket.roomID)); }
    
    const interval = setInterval(() => {
      const r = rooms.get(socket.roomID);
      if (!r || !r.gameState.buzzerLocked) { clearInterval(interval); return; }
      r.gameState.timeLeft--;
      io.to(socket.roomID).emit('timer-tick', { timeLeft: r.gameState.timeLeft, phase: r.gameState.timerPhase });
      
      if (r.gameState.timeLeft <= 0) {
        if (r.gameState.timerPhase === 'answer') {
          r.gameState.timerPhase = 'otherTeam';
          r.gameState.timeLeft = r.settings.otherTeamTime;
          io.to(socket.roomID).emit('timer-phase-change', { phase: 'otherTeam', timeLeft: r.gameState.timeLeft });
        } else {
          clearInterval(interval);
          resetBuzzerState(socket.roomID, r);
          io.to(socket.roomID).emit('buzzer-reset');
          io.to(socket.roomID).emit('game-state', r.gameState);
        }
      }
    }, 1000);
    roomIntervals.set(socket.roomID, interval);
  });

  socket.on('reset-buzzer', () => {
    const room = rooms.get(socket.roomID);
    if (!room) return;
    resetBuzzerState(socket.roomID, room);
    io.to(socket.roomID).emit('buzzer-reset');
    io.to(socket.roomID).emit('game-state', room.gameState);
  });

  socket.on('select-cell', (cellIndex) => {
    const room = rooms.get(socket.roomID);
    if (!room || !room.settings.gameStarted || room.gameState.roundOver) return;
    const cell = room.gameState.cells[cellIndex];
    if (!cell || cell.color) return;
    
    room.gameState.questionActive = true;
    room.gameState.currentCellIndex = cellIndex;
    room.gameState.highlightedCellIndex = cellIndex;
    room.gameState.buzzerLocked = false;
    room.gameState.buzzerWinner = null;
    io.to(socket.roomID).emit('buzzer-reset');
    
    const qData = baseQuestions[cell.letter]?.[Math.floor(Math.random() * baseQuestions[cell.letter]?.length || 0)];
    if (!qData) return;
    room.gameState.currentQuestion = qData.question;
    room.gameState.currentAnswer = qData.answer;
    
    io.to(socket.roomID).emit('game-state', room.gameState);
    io.to(socket.roomID).emit('new-question', { cellIndex, letter: cell.letter, question: room.gameState.currentQuestion, answer: room.gameState.currentAnswer });
    io.to(socket.roomID).emit('host-receive-question', { cellIndex, letter: cell.letter, question: room.gameState.currentQuestion, answer: room.gameState.currentAnswer });
  });

  socket.on('change-question', (data) => {
    const room = rooms.get(socket.roomID);
    if (!room) return;
    const qData = baseQuestions[data.letter]?.[Math.floor(Math.random() * baseQuestions[data.letter]?.length || 0)];
    if (!qData) return;
    resetBuzzerState(socket.roomID, room);
    io.to(socket.roomID).emit('buzzer-reset');
    room.gameState.currentQuestion = qData.question;
    room.gameState.currentAnswer = qData.answer;
    io.to(socket.roomID).emit('new-question', { cellIndex: data.cellIndex, letter: data.letter, question: room.gameState.currentQuestion, answer: room.gameState.currentAnswer });
    io.to(socket.roomID).emit('host-receive-question', { cellIndex: data.cellIndex, letter: data.letter, question: room.gameState.currentQuestion, answer: room.gameState.currentAnswer });
  });

  socket.on('host-assign-point', ({ teamIndex }) => {
    const room = rooms.get(socket.roomID);
    if (!room || room.gameState.currentCellIndex === null || room.gameState.roundOver) return;
    const color = teamIndex === 0 ? room.settings.team1Color : room.settings.team2Color;
    room.gameState.cells[room.gameState.currentCellIndex].color = color;
    room.gameState.highlightedCellIndex = null;
    resetBuzzerState(socket.roomID, room);
    const mode = teamIndex === 0 ? 'horizontal' : 'vertical';
    const roundWon = checkWin(room.gameState, color, mode);
    
    if (roundWon) {
      room.gameState.scores[teamIndex]++;
      if (room.gameState.scores[teamIndex] >= room.settings.winPoints) {
        io.to(socket.roomID).emit('match-winner', { teamName: teamIndex === 0 ? room.settings.team1Name : room.settings.team2Name, teamColor: color });
        room.settings.gameStarted = false; resetBoard(room); room.gameState.scores = [0,0];
        io.to(socket.roomID).emit('game-state', room.gameState);
      } else {
        io.to(socket.roomID).emit('round-winner', { teamName: teamIndex === 0 ? room.settings.team1Name : room.settings.team2Name, teamColor: color, scores: room.gameState.scores, winPoints: room.settings.winPoints });
        resetBoard(room); io.to(socket.roomID).emit('game-state', room.gameState);
      }
    } else {
      io.to(socket.roomID).emit('game-state', room.gameState);
    }
    room.gameState.currentCellIndex = null; room.gameState.currentQuestion = null; room.gameState.currentAnswer = null; room.gameState.questionActive = false;
    io.to(socket.roomID).emit('host-question-cleared'); io.to(socket.roomID).emit('question-cleared');
  });

  socket.on('cancel-ownership', (cellIndex) => {
    const room = rooms.get(socket.roomID);
    if (!room || !room.gameState.cells[cellIndex]?.color) return;
    const cellColor = room.gameState.cells[cellIndex].color;
    room.gameState.cells[cellIndex].color = null;
    if (cellColor === room.settings.team1Color) room.gameState.scores[0] = Math.max(0, room.gameState.scores[0] - 1);
    else if (cellColor === room.settings.team2Color) room.gameState.scores[1] = Math.max(0, room.gameState.scores[1] - 1);
    room.gameState.roundOver = false;
    io.to(socket.roomID).emit('game-state', room.gameState);
  });

  socket.on('host-cancel-selection', () => {
    const room = rooms.get(socket.roomID);
    if (!room) return;
    room.gameState.highlightedCellIndex = null; room.gameState.currentCellIndex = null;
    room.gameState.currentQuestion = null; room.gameState.currentAnswer = null; room.gameState.questionActive = false;
    io.to(socket.roomID).emit('game-state', room.gameState);
    io.to(socket.roomID).emit('host-question-cleared'); io.to(socket.roomID).emit('question-cleared');
  });

  socket.on('reset-question', () => {
    const room = rooms.get(socket.roomID);
    if (!room) return;
    room.gameState.highlightedCellIndex = null; room.gameState.currentCellIndex = null;
    room.gameState.currentQuestion = null; room.gameState.currentAnswer = null; room.gameState.questionActive = false;
    io.to(socket.roomID).emit('game-state', room.gameState);
    io.to(socket.roomID).emit('host-question-cleared'); io.to(socket.roomID).emit('question-cleared');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
});