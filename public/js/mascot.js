// ── Mascot: หุ่นยนต์ SVG เดินไปมาที่ขอบล่างของ .content ──
// ทำงานอิสระจากส่วนอื่น อ่านสถานะจาก botsCache ที่มีอยู่แล้ว ไม่เรียก API เพิ่ม
// export function เดียวคือ initMascot() ที่ app.js เรียกหลัง DOMContentLoaded
(function () {
  const STORAGE_KEY = 'netguard.mascot';
  const MIN_TRIP_MS = 25000, MAX_TRIP_MS = 35000;
  const MIN_PAUSE_MS = 3000, MAX_PAUSE_MS = 8000;
  const BLINK_MIN_MS = 4000, BLINK_MAX_MS = 6000;
  const MASCOT_WIDTH = 56, EDGE_MARGIN = 24;

  let svg, posture, facingGroup, eyeLeft, eyeRight, alertText, zzzText, shadow;

  let enabled = true;
  let tabHidden = false;
  let modalDimmed = false;
  let currentStatus = null; // 'happy' | 'worried' | 'sleeping'
  let direction = 1; // 1 = ขวา, -1 = ซ้าย
  let position = 0; // viewport x (px) ปัจจุบันของหุ่น
  let walkingNow = false; // true เฉพาะช่วงกำลังเคลื่อนที่จริง (happy แต่หยุดพักอยู่ = false)

  let walkTimer = null;
  let blinkTimer = null;

  function rand(min, max) { return min + Math.random() * (max - min); }

  function canRun() { return enabled && !tabHidden && !modalDimmed; }

  function getWalkBounds() {
    const content = document.querySelector('.content');
    const rect = content ? content.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    const min = rect.left + EDGE_MARGIN;
    const max = Math.max(min, rect.left + rect.width - MASCOT_WIDTH - EDGE_MARGIN);
    return { min, max };
  }

  function setFacing(dir) {
    direction = dir;
    facingGroup.classList.toggle('facing-left', dir === -1);
  }

  // เงาเป็น sibling ของ #mascotPosture (ไม่ใช่ลูก) ตั้งใจให้ไม่ขยับตาม bob/breathe/jump ของตัวหุ่น
  // ต้อง toggle คลาสคู่กับ walkingNow เองใน JS เพราะ CSS ไม่มี "previous sibling selector" ที่ใช้งานได้ทั่วไป
  function setWalking(value) {
    walkingNow = value;
    if (shadow) shadow.classList.toggle('walking', value);
  }

  // หยุดการเดินกลางทางแบบ smooth — อ่านตำแหน่งจริงจาก computed transform ก่อน freeze
  // ใช้ทั้งตอน modal เปิดและตอนแท็บไม่ active
  function freezeAtCurrentPosition() {
    try {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(svg).transform);
      position = matrix.m41;
    } catch (err) { /* ใช้ค่า position เดิมถ้าอ่านไม่ได้ */ }
    clearTimeout(walkTimer);
    svg.style.transition = 'none';
    svg.style.transform = `translateX(${position}px)`;
    posture.classList.remove('walking');
  }

  function walkOneLeg() {
    if (!canRun() || currentStatus !== 'happy') return;
    const bounds = getWalkBounds();
    setFacing(direction);
    const target = direction === 1 ? bounds.max : bounds.min;
    const totalRange = Math.max(1, bounds.max - bounds.min);
    const distance = Math.abs(target - position);
    const fullTripMs = rand(MIN_TRIP_MS, MAX_TRIP_MS);
    const durationMs = Math.max(300, (distance / totalRange) * fullTripMs);

    setWalking(true);
    posture.classList.remove('idle-breathe');
    posture.classList.add('walking');
    svg.style.transition = `transform ${durationMs}ms linear`;
    position = target;
    svg.style.transform = `translateX(${position}px)`;

    clearTimeout(walkTimer);
    walkTimer = setTimeout(() => {
      setWalking(false);
      posture.classList.remove('walking');
      posture.classList.add('idle-breathe');
      const pauseMs = rand(MIN_PAUSE_MS, MAX_PAUSE_MS);
      walkTimer = setTimeout(() => {
        direction = direction === 1 ? -1 : 1;
        walkOneLeg();
      }, pauseMs);
    }, durationMs);
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (!canRun() || currentStatus !== 'happy') return;
    blinkTimer = setTimeout(() => {
      if (canRun() && currentStatus === 'happy') blinkOnce();
      scheduleBlink();
    }, rand(BLINK_MIN_MS, BLINK_MAX_MS));
  }

  function blinkOnce() {
    [eyeLeft, eyeRight].forEach((eye) => {
      eye.classList.add('blinking');
      eye.addEventListener('animationend', () => eye.classList.remove('blinking'), { once: true });
    });
  }

  // posture class ที่ "ถูกต้อง" ตาม currentStatus/walkingNow ณ ตอนนี้ (คำนวณสดเสมอ ไม่ใช้ snapshot เก่า)
  // กันปัญหา race: ถ้า status เปลี่ยนระหว่างที่ one-shot animation (spin/jump) กำลังเล่นอยู่
  // การ restore ด้วยค่าที่ capture ไว้ตอนเริ่มเล่นจะกลายเป็นค่าเก่าที่ไม่ตรงกับสถานะจริงแล้ว
  function applyPostureForCurrentStatus() {
    posture.classList.remove('walking', 'idle-breathe', 'shake', 'sit');
    if (currentStatus === 'happy') posture.classList.add(walkingNow ? 'walking' : 'idle-breathe');
    else if (currentStatus === 'worried') posture.classList.add('shake');
    else if (currentStatus === 'sleeping') posture.classList.add('sit');
  }

  // เล่น animation แบบจบในตัว (spin/jump) โดยไม่ชนกับ posture class ที่ค้างอยู่ (walking/idle-breathe/shake/sit)
  // เพราะ element เดียวมี transform ได้ทางเดียว — ต้องถอดของเดิมออกก่อนแล้วค่อยใส่กลับตอนจบ
  function playOneShot(className) {
    posture.classList.remove('walking', 'idle-breathe', 'shake', 'sit', className);
    void posture.offsetWidth; // force reflow กัน animation ไม่ retrigger ถ้าเพิ่งเล่นคลาสเดิมไป
    posture.classList.add(className);
    posture.addEventListener('animationend', () => {
      posture.classList.remove(className);
      applyPostureForCurrentStatus();
    }, { once: true });
  }

  function playLoadingSpin() {
    if (!enabled) return;
    playOneShot('spin-once');
  }

  function applyStatus(status, force) {
    if (status === currentStatus && !force) return; // ไม่เปลี่ยนไม่ต้องทำอะไร
    currentStatus = status;

    // สำคัญ: ต้อง freeze ก่อนเสมอ ไม่งั้น CSS transition ของการเดินรอบก่อน (ถ้ากำลังวิ่งอยู่กลางทาง)
    // จะเดินต่อเบื้องหลังจนจบทั้งที่ status เปลี่ยนเป็น worried/sleeping ไปแล้ว (clearTimeout อย่างเดียวไม่พอ
    // เพราะ CSS transition ที่ commit ไปแล้วไม่ได้ผูกกับ JS timer)
    freezeAtCurrentPosition();

    svg.classList.remove('status-happy', 'status-worried', 'status-sleeping');
    svg.classList.add(`status-${status}`);

    clearTimeout(blinkTimer);
    eyeLeft.classList.remove('eyes-closed');
    eyeRight.classList.remove('eyes-closed');
    alertText.classList.remove('show');
    zzzText.classList.remove('show');
    setWalking(false);
    posture.classList.remove('walking', 'idle-breathe', 'shake', 'sit');

    if (status === 'happy') {
      posture.classList.add('idle-breathe');
      if (canRun()) { walkOneLeg(); scheduleBlink(); }
    } else if (status === 'worried') {
      posture.classList.add('shake');
      alertText.classList.add('show');
    } else if (status === 'sleeping') {
      posture.classList.add('sit');
      eyeLeft.classList.add('eyes-closed');
      eyeRight.classList.add('eyes-closed');
      zzzText.classList.add('show');
    }
  }

  // เดินต่อ/สั่นต่อ/นั่งต่อ ตามสถานะปัจจุบัน — ใช้ตอนกลับจาก modal ปิด / แท็บกลับมา active / เปิด toggle
  function tryResume() {
    if (!canRun()) return;
    if (currentStatus === 'happy') { walkOneLeg(); scheduleBlink(); }
    else applyPostureForCurrentStatus();
  }

  function computeStatus() {
    // botsCache ประกาศด้วย let ใน app.js — เป็น script-global lexical binding ไม่ใช่ property ของ window
    // (ต่างจาก loadBots/botStatus ที่เป็น function declaration ซึ่งผูกกับ window ด้วย) ต้องอ้างชื่อตรงๆ
    const bots = typeof botsCache !== 'undefined' ? botsCache : [];
    if (!bots.length) return 'sleeping';
    const hasProblem = bots.some((b) => typeof botStatus === 'function' && botStatus(b) === 'problem');
    return hasProblem ? 'worried' : 'happy';
  }

  function loadEnabledPref() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === 'true';
    } catch (err) { return true; }
  }
  function saveEnabledPref(value) {
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch (err) { /* private mode / quota — เพิกเฉย */ }
  }

  function updateToggleUI() {
    const btn = document.getElementById('mascotToggle');
    if (!btn) return;
    btn.classList.toggle('mascot-on', enabled);
    btn.setAttribute('aria-pressed', String(enabled));
  }

  function setEnabled(value) {
    enabled = value;
    saveEnabledPref(value);
    updateToggleUI();
    if (!enabled) {
      svg.classList.add('hidden');
      clearTimeout(walkTimer);
      clearTimeout(blinkTimer);
    } else {
      svg.classList.remove('hidden');
      tryResume();
    }
  }

  function updateModalDimState() {
    const anyOpen = !!document.querySelector('.modal-overlay.show');
    if (anyOpen === modalDimmed) return;
    modalDimmed = anyOpen;
    svg.classList.toggle('modal-dim', anyOpen);
    if (anyOpen) {
      freezeAtCurrentPosition();
      clearTimeout(blinkTimer);
    } else {
      tryResume();
    }
  }

  function initMascot() {
    svg = document.getElementById('mascotSvg');
    if (!svg) return;
    if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) return;

    posture = document.getElementById('mascotPosture');
    facingGroup = document.getElementById('mascotFacing');
    eyeLeft = document.getElementById('eyeLeft');
    eyeRight = document.getElementById('eyeRight');
    alertText = document.getElementById('mascotAlert');
    zzzText = document.getElementById('mascotZzz');

    // เงาใต้หุ่น — สร้างด้วย JS (createElementNS) แทนการเพิ่ม markup ใน index.html เพราะรอบนี้
    // แก้ได้เฉพาะไฟล์ css/js เท่านั้น แทรกเป็น sibling ก่อน #mascotPosture (พื้นหลังสุด ไม่ขยับตาม bob/jump)
    if (!document.getElementById('mascotShadow')) {
      shadow = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      shadow.setAttribute('id', 'mascotShadow');
      shadow.setAttribute('class', 'mascot-shadow');
      shadow.setAttribute('cx', '32');
      shadow.setAttribute('cy', '72');
      shadow.setAttribute('rx', '14');
      shadow.setAttribute('ry', '3.5');
      facingGroup.insertBefore(shadow, facingGroup.firstChild);
    } else {
      shadow = document.getElementById('mascotShadow');
    }

    const bounds = getWalkBounds();
    position = bounds.min;
    svg.style.transition = 'none';
    svg.style.transform = `translateX(${position}px)`;

    enabled = loadEnabledPref();
    updateToggleUI();
    svg.classList.toggle('hidden', !enabled);

    const toggleBtn = document.getElementById('mascotToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => setEnabled(!enabled));
    svg.addEventListener('click', () => {
      if (!enabled) return;
      playOneShot('jump-spin');
      // เงาหดแล้วขยายกลับพร้อมจังหวะกระโดด (สื่อว่าตัวหุ่นลอยขึ้นจากพื้น) — เล่นแยกจาก posture
      // เพราะ shadow เป็น sibling ไม่ใช่ลูกของ posture (ไม่ขยับตาม translateY ตอนกระโดด)
      shadow.classList.remove('jump-shrink');
      void shadow.getBoundingClientRect(); // force reflow กัน animation ไม่ retrigger
      shadow.classList.add('jump-shrink');
      shadow.addEventListener('animationend', () => shadow.classList.remove('jump-shrink'), { once: true });
    });

    document.querySelectorAll('.modal-overlay').forEach((el) => {
      new MutationObserver(updateModalDimState).observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        tabHidden = true;
        freezeAtCurrentPosition();
        clearTimeout(blinkTimer);
      } else {
        tabHidden = false;
        tryResume();
      }
    });

    window.addEventListener('resize', () => {
      const b = getWalkBounds();
      if (position > b.max || position < b.min) {
        position = Math.min(Math.max(position, b.min), b.max);
        svg.style.transition = 'none';
        svg.style.transform = `translateX(${position}px)`;
      }
    });

    // ผูกกับ loadBots ที่มีอยู่แล้ว — หมุนตัวตอนกำลังโหลด + รีเช็คสถานะทุกครั้งที่โหลดเสร็จ
    // ไม่ต้องแก้ api.js เพราะห่อ (wrap) function เดิมแทน
    const originalLoadBots = window.loadBots;
    if (typeof originalLoadBots === 'function') {
      window.loadBots = async function patchedLoadBots(...args) {
        playLoadingSpin();
        const result = await originalLoadBots.apply(this, args);
        applyStatus(computeStatus());
        return result;
      };
    }

    applyStatus(computeStatus(), true);

    // เผื่อ loadBots รอบแรก (เรียกจาก app.js ก่อน initMascot จะ wrap ทัน) ยังไม่เสร็จตอนนี้
    // → poll สั้นๆ จนกว่า botsCache จะมีข้อมูลจริง (หรือยืนยันว่าว่างจริงภายใน 5 วิ ก็ปล่อยเป็น sleeping ต่อ)
    let bootstrapTicks = 0;
    const bootstrapPoll = setInterval(() => {
      bootstrapTicks += 1;
      if ((typeof botsCache !== 'undefined' ? botsCache : []).length > 0) {
        clearInterval(bootstrapPoll);
        applyStatus(computeStatus());
      } else if (bootstrapTicks >= 16) {
        clearInterval(bootstrapPoll);
      }
    }, 300);
  }

  window.initMascot = initMascot;
})();
