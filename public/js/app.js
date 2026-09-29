// ── State ──
const tbody = document.getElementById('botTableBody');
const botsCard = document.getElementById('botsCard');
const emptyStateNone = document.getElementById('emptyStateNone');
const emptyStateFiltered = document.getElementById('emptyStateFiltered');

const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');
const refreshBtn = document.getElementById('refreshBtn');
const refreshNote = document.getElementById('refreshNote');

const logModal = document.getElementById('logModal');
const logModalBody = document.getElementById('logModalBody');
const logModalTitle = document.getElementById('logModalTitle');

const createModal = document.getElementById('createModal');
const createError = document.getElementById('createError');
const newBotName = document.getElementById('newBotName');
const newBotPort = document.getElementById('newBotPort');
const createSubmitBtn = document.getElementById('createSubmitBtn');

const removeModal = document.getElementById('removeModal');
const removeConfirmText = document.getElementById('removeConfirmText');
const removeDeleteFiles = document.getElementById('removeDeleteFiles');
const removeConfirmBtn = document.getElementById('removeConfirmBtn');

const attachTunnelModal = document.getElementById('attachTunnelModal');
const attachTunnelTitle = document.getElementById('attachTunnelTitle');
const attachTunnelError = document.getElementById('attachTunnelError');
const attachTunnelToken = document.getElementById('attachTunnelToken');
const attachTunnelSubmitBtn = document.getElementById('attachTunnelSubmitBtn');

const newBotToken = document.getElementById('newBotToken');
const newBotCompany = document.getElementById('newBotCompany');

const editMetaModal = document.getElementById('editMetaModal');
const editMetaTitle = document.getElementById('editMetaTitle');
const editMetaError = document.getElementById('editMetaError');
const editCompanyName = document.getElementById('editCompanyName');
const editContactName = document.getElementById('editContactName');
const editContactPhone = document.getElementById('editContactPhone');
const editContractEnd = document.getElementById('editContractEnd');
const editNote = document.getElementById('editNote');
const editCreatedAtDisplay = document.getElementById('editCreatedAtDisplay');
const editMetaSubmitBtn = document.getElementById('editMetaSubmitBtn');

const configModal = document.getElementById('configModal');
const configModalTitle = document.getElementById('configModalTitle');
const configModalError = document.getElementById('configModalError');
const configModalBody = document.getElementById('configModalBody');
const configSaveBtn = document.getElementById('configSaveBtn');
const configSaveRestartBtn = document.getElementById('configSaveRestartBtn');

const statsModal = document.getElementById('statsModal');
const statsModalTitle = document.getElementById('statsModalTitle');
const statsModalBody = document.getElementById('statsModalBody');

const toastContainer = document.getElementById('toastContainer');

const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const hamburgerBtn = document.getElementById('hamburgerBtn');

let botsCache = [];
let uptimeChart = null;
let problemsChart = null;
let removeTarget = null;
let attachTunnelTarget = null;
let editMetaTarget = null;
let refreshTimer = null;
let noteTimer = null;
let searchQuery = '';
let activeCardFilter = '';
let lastRefreshedAt = null;
let lastRenderedRowIds = null;
let sparklineCharts = {};
let sparklineCacheAt = 0;

// ── Summary card filter (toggle) ──
document.querySelectorAll('.summary-card').forEach((card) => {
  card.addEventListener('click', () => {
    const f = card.dataset.filter;
    activeCardFilter = f === '' ? '' : (activeCardFilter === f ? '' : f);
    updateActiveCardUI();
    renderTable();
  });
});

// ── Search ──
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  searchClearBtn.hidden = !searchQuery;
  renderTable();
});
searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  searchClearBtn.hidden = true;
  renderTable();
  searchInput.focus();
});

document.getElementById('clearFiltersBtn').addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  searchClearBtn.hidden = true;
  activeCardFilter = '';
  updateActiveCardUI();
  renderTable();
});
document.getElementById('emptyCreateBtn').addEventListener('click', openCreateModal);

// ── Manual refresh + "อัปเดตเมื่อ..." ──
noteTimer = setInterval(updateRefreshNote, 1000);

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  try {
    await loadBots();
    flashSummaryCards();
  } finally {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
});

// เมนูยึดตำแหน่งจาก getBoundingClientRect ตอนเปิด — ถ้า scroll แล้วตำแหน่งเพี้ยน ให้ปิดไปเลย
window.addEventListener('scroll', () => closeAllKebabs(), true);

// event delegation — ผูกครั้งเดียว ไม่ต้อง re-attach ทุกรอบ render
tbody.addEventListener('click', (e) => {
  const kebabToggle = e.target.closest('[data-kebab-toggle]');
  if (kebabToggle) { e.stopPropagation(); toggleKebab(kebabToggle); return; }

  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    closeAllKebabs();
    onActionClick(actionBtn);
    return;
  }

  if (e.target.closest('a')) return;

  const tr = e.target.closest('tr[data-name]');
  if (tr) openStatsModal(tr.dataset.name);
});

tbody.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const tr = e.target.closest('tr[data-name]');
  if (tr && e.target === tr) {
    e.preventDefault();
    openStatsModal(tr.dataset.name);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.kebab-wrap')) closeAllKebabs();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeAllKebabs();
  if (configModal.classList.contains('show')) closeConfigModal();
  document.querySelectorAll('.modal-overlay.show').forEach((m) => m.classList.remove('show'));
});

// ── Log modal ──
document.getElementById('logModalClose').addEventListener('click', closeLogModal);
logModal.addEventListener('click', (e) => {
  if (e.target === logModal) closeLogModal();
});

// ── Create bot modal ──
document.getElementById('openCreateBtn').addEventListener('click', openCreateModal);
document.getElementById('createModalClose').addEventListener('click', closeCreateModal);
document.getElementById('createCancelBtn').addEventListener('click', closeCreateModal);
createModal.addEventListener('click', (e) => {
  if (e.target === createModal) closeCreateModal();
});
document.getElementById('createSubmitBtn').addEventListener('click', submitCreateBot);

// ── Attach tunnel modal ──
document.getElementById('attachTunnelModalClose').addEventListener('click', closeAttachTunnelModal);
document.getElementById('attachTunnelCancelBtn').addEventListener('click', closeAttachTunnelModal);
attachTunnelModal.addEventListener('click', (e) => {
  if (e.target === attachTunnelModal) closeAttachTunnelModal();
});
attachTunnelSubmitBtn.addEventListener('click', submitAttachTunnel);

// ── Edit customer meta modal ──
document.getElementById('editMetaModalClose').addEventListener('click', closeEditMetaModal);
document.getElementById('editMetaCancelBtn').addEventListener('click', closeEditMetaModal);
editMetaModal.addEventListener('click', (e) => {
  if (e.target === editMetaModal) closeEditMetaModal();
});
editMetaSubmitBtn.addEventListener('click', submitEditMeta);

// ── Bot config modal (.env) ──
document.getElementById('configModalClose').addEventListener('click', closeConfigModal);
document.getElementById('configCancelBtn').addEventListener('click', closeConfigModal);
configModal.addEventListener('click', (e) => {
  if (e.target === configModal) closeConfigModal();
});
configSaveBtn.addEventListener('click', () => submitConfigModal(false));
configSaveRestartBtn.addEventListener('click', () => submitConfigModal(true));
configModalBody.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-toggle-vis]');
  if (toggleBtn) {
    const input = document.getElementById(toggleBtn.dataset.toggleVis);
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }
  const clearBtn = e.target.closest('[data-clear-field]');
  if (clearBtn) toggleClearSecret(clearBtn);
});
configModalBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) {
    e.preventDefault();
    submitConfigModal(false);
  }
});

// ── Remove confirm modal ──
document.getElementById('removeModalClose').addEventListener('click', closeRemoveModal);
document.getElementById('removeCancelBtn').addEventListener('click', closeRemoveModal);
removeModal.addEventListener('click', (e) => {
  if (e.target === removeModal) closeRemoveModal();
});
removeConfirmBtn.addEventListener('click', submitRemoveBot);

// ── Stats detail modal ──
document.getElementById('statsModalClose').addEventListener('click', closeStatsModal);
statsModal.addEventListener('click', (e) => {
  if (e.target === statsModal) closeStatsModal();
});

// ── Update image / logout ──
document.getElementById('pullImageBtn').addEventListener('click', (e) => submitPullImage(e.currentTarget));
document.getElementById('logoutBtn').addEventListener('click', submitLogout);

// ── Mobile sidebar (hamburger + overlay + Escape) ──
function openSidebar() {
  sidebar.classList.add('show');
  sidebarOverlay.classList.add('show');
  hamburgerBtn.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  sidebar.classList.remove('show');
  sidebarOverlay.classList.remove('show');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
}
hamburgerBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('show')) closeSidebar();
  else openSidebar();
});
sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('show')) closeSidebar();
});

// ── Atmosphere parallax (background grid/orbs เลื่อนช้ากว่า content ตอน scroll) ──
// อยู่ในไฟล์นี้แทนไฟล์แยก เพราะรอบนี้แก้ได้เฉพาะไฟล์ css/js — เพิ่ม <script> ใหม่ใน index.html ไม่ได้
function initAtmosphereParallax() {
  if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) return; // parallax คือ motion — ปิดถ้า reduced-motion

  const mainArea = document.querySelector('.main-area');
  if (!mainArea) return;

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      // อ่าน scrollTop ครั้งเดียวต่อเฟรม (throttle ผ่าน ticking flag) ไม่อ่านซ้ำใน loop
      document.documentElement.style.setProperty('--scroll-y', `${mainArea.scrollTop}px`);
      ticking = false;
    });
  }
  mainArea.addEventListener('scroll', onScroll, { passive: true });
}

// ── Init ──
loadBots();
// เรียกผ่าน arrow function เสมอ (ไม่ใช่ setInterval(loadBots, ...) ตรงๆ) เพื่อให้ mascot.js
// ที่โหลดทีหลังและ wrap window.loadBots ไว้ ทำงานกับ auto-refresh ได้ด้วย ไม่ใช่แค่ตอนกดปุ่ม
refreshTimer = setInterval(() => loadBots(), 10000);

document.addEventListener('DOMContentLoaded', () => {
  if (typeof initMascot === 'function') initMascot();
  if (typeof initNetworkBg === 'function') initNetworkBg();
  initAtmosphereParallax();
});
