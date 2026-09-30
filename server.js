// =====================================================================
//  Plague Doctor - เซิร์ฟเวอร์ออนไลน์ (Node.js + Socket.io)
//  หน้าที่: รับผู้เล่นเข้า-ออก · รับส่ง ID / ชื่อ / ตำแหน่งตัวละคร
//  รัน:  npm install   แล้ว   npm start   (ค่าเริ่มต้นพอร์ต 3000)
// =====================================================================
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// ใส่โดเมนเว็บเกมของคุณ คั่นด้วย , เช่น "https://mygame.netlify.app,http://localhost:5500"
// ถ้าไม่ตั้ง = อนุญาตทุกเว็บ (สะดวกตอนทดสอบ แต่ตอนใช้จริงควรตั้ง)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const MAX_PLAYERS = 200;          // จำนวนผู้เล่นพร้อมกันสูงสุด
const MOVE_MIN_MS = 45;           // รับตำแหน่งได้ไม่ถี่เกิน ~22 ครั้ง/วินาที ต่อคน
const MAX_STEP = 400;             // ระยะที่ขยับได้มากสุดต่อ 1 ข้อความ (กันวาร์ป/โกง) · ย้ายแมพใช้ event 'teleport'
const WORLD = { x0: 0, x1: 12300, y0: 0, y1: 3000 }; // ขอบโลกของเกม

// ---------- ข้อมูลผู้เล่นทั้งหมดในหน่วยความจำ ----------
// players: socket.id -> { id, name, cls, gender, look, map, x, y, f, riding, t }
const players = new Map();

// ---------- ตัวช่วยตรวจข้อมูล (อย่าเชื่อข้อมูลจากฝั่งเว็บ 100%) ----------
const num = (v, lo, hi, def = 0) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
const str = (v, max, def = '') => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, max) : def) || def;
const CLASSES = ['Novice', 'Swordsman', 'Archer', 'Brawler', 'Qigong'];

// ข้อมูลที่ส่งให้ผู้เล่นคนอื่น (ไม่ส่ง socket.id จริงออกไป)
const pub = p => ({ id: p.id, name: p.name, cls: p.cls, gender: p.gender, look: p.look, map: p.map, x: p.x, y: p.y, f: p.f, riding: p.riding });
const room = map => 'map:' + map;

// ---------- เซิร์ฟเวอร์ ----------
const httpServer = http.createServer((req, res) => {
  // หน้าเช็กสถานะ: เปิด http://localhost:3000/ ดูได้ว่าเซิร์ฟเวอร์ทำงานอยู่ไหม
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, game: 'Plague Doctor', online: players.size }));
});

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS },
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 16 * 1024, // ข้อความใหญ่สุด 16KB
});

io.on('connection', socket => {
  let me = null;

  // 1) ผู้เล่นเข้าเกม: ส่ง ID ชื่อ อาชีพ หน้าตา แมพ และตำแหน่งเริ่มต้น
  socket.on('join', (data = {}, ack) => {
    if (me) return;
    if (players.size >= MAX_PLAYERS) { ack && ack({ ok: false, error: 'เซิร์ฟเวอร์เต็ม' }); return socket.disconnect(true); }
    const id = str(data.id, 24);
    if (!id) { ack && ack({ ok: false, error: 'ต้องมี id' }); return; }
    // ID ซ้ำ (เปิด 2 แท็บ) -> เตะอันเก่าออก
    for (const [sid, p] of players) if (p.id === id) { const old = io.sockets.sockets.get(sid); old && old.disconnect(true); }

    me = {
      id,
      name: str(data.name, 16, id),
      cls: CLASSES.includes(data.cls) ? data.cls : 'Novice',
      gender: data.gender === 'f' ? 'f' : 'm',
      look: data.look && typeof data.look === 'object' ? { hairS: str(data.look.hairS, 12), hairC: str(data.look.hairC, 9), skin: str(data.look.skin, 9) } : null,
      map: num(data.map, 0, 10, 4) | 0,
      x: num(data.x, WORLD.x0, WORLD.x1), y: num(data.y, WORLD.y0, WORLD.y1),
      f: data.f === -1 ? -1 : 1, riding: !!data.riding, t: 0,
    };
    players.set(socket.id, me);
    socket.join(room(me.map));

    // ส่งรายชื่อผู้เล่นที่อยู่แมพเดียวกันกลับไปให้คนที่เพิ่งเข้า
    const others = [...players.values()].filter(p => p !== me && p.map === me.map).map(pub);
    ack && ack({ ok: true, you: pub(me), players: others, online: players.size });
    // บอกคนอื่นในแมพว่ามีคนเข้ามา
    socket.to(room(me.map)).emit('playerJoined', pub(me));
    console.log(`[+] ${me.name} (${me.id}) เข้าเกม · ออนไลน์ ${players.size}`);
  });

  // 2) ตำแหน่งตัวละคร (ส่งมาเรื่อยๆ ตอนเดิน)
  socket.on('move', (d = {}) => {
    if (!me) return;
    const now = Date.now();
    if (now - me.t < MOVE_MIN_MS) return; // ถี่เกินไป ทิ้ง
    const x = num(d.x, WORLD.x0, WORLD.x1, me.x), y = num(d.y, WORLD.y0, WORLD.y1, me.y);
    if (Math.hypot(x - me.x, y - me.y) > MAX_STEP) return; // กระโดดไกลผิดปกติ ไม่รับ
    me.x = x; me.y = y; me.t = now;
    if (d.f === 1 || d.f === -1) me.f = d.f;
    me.riding = !!d.riding;
    socket.to(room(me.map)).volatile.emit('playerMoved', { id: me.id, x: me.x, y: me.y, f: me.f, riding: me.riding });
  });

  // 3) ย้ายแมพ / วาร์ป (ประตูมิติ บัตรวาร์ป ตาย-เกิดใหม่)
  socket.on('teleport', (d = {}) => {
    if (!me) return;
    const map = num(d.map, 0, 10, me.map) | 0;
    me.x = num(d.x, WORLD.x0, WORLD.x1, me.x); me.y = num(d.y, WORLD.y0, WORLD.y1, me.y);
    if (map !== me.map) {
      socket.to(room(me.map)).emit('playerLeft', { id: me.id });
      socket.leave(room(me.map));
      me.map = map;
      socket.join(room(map));
      socket.emit('mapPlayers', [...players.values()].filter(p => p !== me && p.map === map).map(pub));
      socket.to(room(map)).emit('playerJoined', pub(me));
    } else {
      socket.to(room(me.map)).emit('playerMoved', { id: me.id, x: me.x, y: me.y, f: me.f, riding: me.riding, snap: true });
    }
  });

  // 4) เปลี่ยนหน้าตา/อาชีพ (เช่น เปลี่ยนอาชีพที่ศาลากลาง)
  socket.on('look', (d = {}) => {
    if (!me) return;
    if (CLASSES.includes(d.cls)) me.cls = d.cls;
    if (d.gender === 'f' || d.gender === 'm') me.gender = d.gender;
    if (d.look && typeof d.look === 'object') me.look = { hairS: str(d.look.hairS, 12), hairC: str(d.look.hairC, 9), skin: str(d.look.skin, 9) };
    socket.to(room(me.map)).emit('playerLook', { id: me.id, cls: me.cls, gender: me.gender, look: me.look });
  });

  // 5) ออกจากเกม / เน็ตหลุด
  socket.on('disconnect', () => {
    if (!me) return;
    players.delete(socket.id);
    io.to(room(me.map)).emit('playerLeft', { id: me.id });
    console.log(`[-] ${me.name} (${me.id}) ออกจากเกม · ออนไลน์ ${players.size}`);
  });
});

httpServer.listen(PORT, () => console.log(`🟢 Plague Doctor server พร้อมแล้ว ที่พอร์ต ${PORT}`));
