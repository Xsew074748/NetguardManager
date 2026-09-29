// ── Network background: จุดลอยสุ่มอิสระ + เส้นเชื่อมจางๆ วาดด้วย canvas 2D ──
// เป็น background layer เบาๆ อยู่หลังสุด ไม่ผูกกับข้อมูล bot จริง
// export function เดียวคือ initNetworkBg() ที่ app.js เรียกหลัง DOMContentLoaded (จุดเดียวกับ initMascot)
(function () {
  const MIN_NODES = 20, MAX_NODES = 70, AREA_PER_NODE = 18000;
  const MAX_SPEED = 0.15; // px/frame
  const RADIUS_MIN = 1, RADIUS_MAX = 2;
  const LINK_DIST = 140;
  const LINK_ALPHA_MAX = 0.15;
  const NODE_ALPHA = 0.5;
  // สีตรงกับ --teal/--purple ใน theme.css (ใช้ค่าเดียวกับที่ atmosphere.css ใช้ทำ orbs)
  const COLOR_TEAL = '#00d4a0';
  const COLOR_PURPLE = '#7c6cf6';
  const DENSE_THRESHOLD = 50;
  const NEIGHBOR_CHECK_LIMIT = 8; // node เกิน 50 ตัว เช็คระยะห่างแค่ 8 ตัวถัดไปในลิสต์ (approx O(n))
  const RESIZE_DEBOUNCE_MS = 200;

  let canvas, ctx;
  let nodes = [];
  let rafId = null;
  let tabHidden = false;
  let reducedMotion = false;
  let dpr = 1;
  let cssWidth = 0, cssHeight = 0;
  let resizeTimer = null;

  function rand(min, max) { return min + Math.random() * (max - min); }

  function computeNodeCount(w, h) {
    return Math.min(MAX_NODES, Math.max(MIN_NODES, Math.floor((w * h) / AREA_PER_NODE)));
  }

  function makeNode(w, h) {
    return {
      x: rand(0, w),
      y: rand(0, h),
      vx: rand(-MAX_SPEED, MAX_SPEED),
      vy: rand(-MAX_SPEED, MAX_SPEED),
      radius: rand(RADIUS_MIN, RADIUS_MAX),
      // สุ่มสีครั้งเดียวตอนสร้าง node แล้วคงที่ — ไม่สุ่มใหม่ทุก frame
      color: Math.random() < 0.5 ? COLOR_TEAL : COLOR_PURPLE,
    };
  }

  function resizeCanvas() {
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const targetCount = computeNodeCount(cssWidth, cssHeight);
    if (targetCount > nodes.length) {
      while (nodes.length < targetCount) nodes.push(makeNode(cssWidth, cssHeight));
    } else if (targetCount < nodes.length) {
      nodes.length = targetCount;
    }
    // node เดิมที่ยังอยู่ในจอไม่ต้อง reset ตำแหน่ง — clamp เฉพาะตัวที่ล้นขอบจอใหม่ (เช่น ย่อหน้าต่าง)
    nodes.forEach((n) => {
      if (n.x > cssWidth) n.x = cssWidth;
      if (n.y > cssHeight) n.y = cssHeight;
    });
  }

  function step() {
    nodes.forEach((n) => {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x <= 0 || n.x >= cssWidth) { n.vx *= -1; n.x = Math.min(Math.max(n.x, 0), cssWidth); }
      if (n.y <= 0 || n.y >= cssHeight) { n.vy *= -1; n.y = Math.min(Math.max(n.y, 0), cssHeight); }
    });
  }

  function draw() {
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // เส้นเชื่อม — node เกิน 50 ตัว เช็คระยะห่างเฉพาะกับ node ถัดไปในลิสต์ไม่เกิน 8 ตัว
    // (spatial approximation แบบง่าย แทน quadtree เต็มรูป — พอสำหรับเอฟเฟกต์ background ที่จางอยู่แล้ว)
    const limitNeighbors = nodes.length > DENSE_THRESHOLD;
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const maxJ = limitNeighbors ? Math.min(nodes.length, i + 1 + NEIGHBOR_CHECK_LIMIT) : nodes.length;
      for (let j = i + 1; j < maxJ; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < LINK_DIST) {
          const alpha = (1 - dist / LINK_DIST) * LINK_ALPHA_MAX;
          ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = NODE_ALPHA;
    nodes.forEach((n) => {
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // rAF loop เดินต่อเองก็ต่อเมื่อไม่ reduced-motion และแท็บยัง active — ไม่งั้นวาดเฟรมเดียวแล้วจบ
  function frame() {
    step();
    draw();
    if (!reducedMotion && !tabHidden) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = null;
    }
  }

  function resumeIfNeeded() {
    if (rafId) return; // มี loop วิ่งอยู่แล้ว
    if (reducedMotion) {
      draw(); // background ไม่ใช่ motion หลัก — ไม่ซ่อน แค่หยุดนิ่งที่ 1 เฟรม
    } else if (!tabHidden) {
      rafId = requestAnimationFrame(frame);
    }
  }

  function pauseLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function initNetworkBg() {
    if (document.getElementById('networkBgCanvas')) return; // กันสร้างซ้ำถ้าเผลอเรียกซ้ำ

    canvas = document.createElement('canvas');
    canvas.id = 'networkBgCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    // แทรกเป็น child แรกของ body — อยู่หลังสุดโดยธรรมชาติ ไม่ต้องพึ่ง z-index สูงต่ำเพียงอย่างเดียว
    document.body.insertBefore(canvas, document.body.firstChild);
    ctx = canvas.getContext('2d');

    reducedMotion = typeof prefersReducedMotion === 'function' ? prefersReducedMotion() : false;
    tabHidden = document.visibilityState === 'hidden';

    resizeCanvas();

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeCanvas();
        draw();
      }, RESIZE_DEBOUNCE_MS);
    });

    // pause เมื่อแท็บไม่ active — pattern เดียวกับ mascot.js (freeze แล้ว resume ตอนกลับมา)
    document.addEventListener('visibilitychange', () => {
      tabHidden = document.visibilityState === 'hidden';
      if (tabHidden) pauseLoop();
      else resumeIfNeeded();
    });

    // prefers-reduced-motion เปลี่ยนได้ระหว่างใช้งาน — ต้องหยุด/เริ่มถูกต้องทันที
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleMotionChange = (e) => {
      reducedMotion = e.matches;
      pauseLoop();
      resumeIfNeeded();
    };
    if (media.addEventListener) media.addEventListener('change', handleMotionChange);
    else if (media.addListener) media.addListener(handleMotionChange); // fallback เบราว์เซอร์เก่า

    resumeIfNeeded();
  }

  window.initNetworkBg = initNetworkBg;
})();
