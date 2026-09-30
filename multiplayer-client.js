// =====================================================================
//  Plague Doctor - โค้ดฝั่งเว็บ (ต่อกับเซิร์ฟเวอร์ Socket.io)
//  วิธีใช้: ใส่ 2 บรรทัดนี้ไว้ท้ายไฟล์เกม ก่อน </body>
//    <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
//    <script src="multiplayer-client.js"></script>
//  แล้วแก้ SERVER_URL ด้านล่างเป็นที่อยู่เซิร์ฟเวอร์ของคุณ
// =====================================================================
(function () {
  const SERVER_URL = 'http://localhost:3000'; // เปลี่ยนเป็น https://ชื่อเซิร์ฟเวอร์ของคุณ ตอนขึ้นใช้จริง
  const SEND_MS = 80;                          // ส่งตำแหน่งทุก 80ms (~12 ครั้ง/วินาที)

  const others = new Map();                    // id -> ผู้เล่นคนอื่น { ..., tx, ty (ตำแหน่งเป้าหมาย) }
  let socket = null, joinedAs = null, lastSent = { x: 0, y: 0, f: 1, riding: false }, lastMap = -1;

  function connect() {
    if (typeof io === 'undefined') return console.warn('[MP] ยังไม่ได้โหลด socket.io');
    socket = io(SERVER_URL, { transports: ['websocket'], reconnection: true });

    socket.on('connect', () => { joinedAs = null; tryJoin(); });
    socket.on('disconnect', () => { others.clear(); joinedAs = null; });

    socket.on('playerJoined', pl => addOther(pl));
    socket.on('mapPlayers', list => { others.clear(); list.forEach(addOther); });
    socket.on('playerMoved', d => { const o = others.get(d.id); if (!o) return; o.tx = d.x; o.ty = d.y; o.f = d.f; o.riding = d.riding; if (d.snap) { o.x = d.x; o.y = d.y; } });
    socket.on('playerLook', d => { const o = others.get(d.id); if (o) Object.assign(o, d); });
    socket.on('playerLeft', d => others.delete(d.id));
  }

  function addOther(pl) { others.set(pl.id, { ...pl, tx: pl.x, ty: pl.y, _mp: 1 }); }

  // เข้าเกมเมื่อสร้าง/โหลดตัวละครเสร็จแล้ว (ตัวแปร p ของเกม)
  function tryJoin() {
    if (!socket || !socket.connected || typeof p === 'undefined' || !p || joinedAs === p.id) return;
    joinedAs = p.id; lastMap = mapOf(p.x);
    socket.emit('join', { id: p.id, name: p.name || p.id, cls: p.cls, gender: p.gender, look: p.look, map: lastMap, x: p.x, y: p.y, f: p.f, riding: !!p.riding }, res => {
      if (!res || !res.ok) { joinedAs = null; return console.warn('[MP] เข้าเกมไม่ได้:', res && res.error); }
      others.clear(); res.players.forEach(addOther);
      if (typeof logStatus === 'function') logStatus(`🌐 ออนไลน์แล้ว · มีผู้เล่น ${res.online} คน`);
    });
  }

  // ส่งตำแหน่งของเรา (ส่งเฉพาะตอนขยับ)
  setInterval(() => {
    if (!socket || !socket.connected || typeof p === 'undefined' || !p) return;
    if (joinedAs !== p.id) return tryJoin();
    const mi = mapOf(p.x);
    if (mi !== lastMap || Math.hypot(p.x - lastSent.x, p.y - lastSent.y) > 300) { // ย้ายแมพหรือวาร์ป
      lastMap = mi; socket.emit('teleport', { map: mi, x: p.x, y: p.y });
    } else if (Math.abs(p.x - lastSent.x) > .5 || Math.abs(p.y - lastSent.y) > .5 || p.f !== lastSent.f || !!p.riding !== lastSent.riding) {
      socket.emit('move', { x: Math.round(p.x), y: Math.round(p.y), f: p.f, riding: !!p.riding });
    } else return;
    lastSent = { x: p.x, y: p.y, f: p.f, riding: !!p.riding };
  }, SEND_MS);

  // วาดผู้เล่นคนอื่น: แทรกก่อนวาดกระสุน (หลังวาดตัวละคร/ต้นไม้ของเกม)
  const origDrawProjs = window.drawProjs || drawProjs;
  window.drawProjs = function () {
    try {
      if (typeof p !== 'undefined' && p && !inHouse) {
        for (const o of others.values()) {
          // เดินลื่นๆ: ค่อยๆ ขยับเข้าหาตำแหน่งล่าสุดที่ได้รับ
          o.x += (o.tx - o.x) * .25; o.y += (o.ty - o.y) * .25;
          if (o.x < cam.x - 80 || o.x > cam.x + VW + 80 || o.y < cam.y - 100 || o.y > cam.y + VH + 100) continue;
          ctx.fillStyle = '#0004'; ctx.beginPath(); ctx.ellipse(o.x, o.y + 13, 13, 5, 0, 0, 7); ctx.fill();
          drawHero(o, o.cls || 'Novice');
          label(o.name, o.x, o.y - 64, '#8fd0ff', 1); // ชื่อผู้เล่นอื่นเป็นสีฟ้า
        }
      }
    } catch (e) { console.warn('[MP] draw', e); }
    return origDrawProjs.apply(this, arguments);
  };
  try { drawProjs = window.drawProjs; } catch (e) {}

  // บอกเซิร์ฟเวอร์เวลาเปลี่ยนอาชีพ/หน้าตา (เรียกเองได้: window.mpSendLook())
  window.mpSendLook = () => socket && socket.connected && p && socket.emit('look', { cls: p.cls, gender: p.gender, look: p.look });
  window.mpOthers = others; // เปิดดูผู้เล่นคนอื่นใน console ได้

  connect();
})();
