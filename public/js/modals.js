const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const STATE_LABEL = { up: 'Up', down: 'Down', unknown: 'Unknown' };

function isValidTunnelToken(token) {
  return token.length > 20 && !/\s/.test(token);
}

// ── Kebab dropdown menu ──
// position: fixed + top/left คำนวณเอง (ไม่ใช้ CSS anchor) เพราะ .card มี overflow:hidden
// ซึ่งจะ clip dropdown ถ้าปล่อยให้เป็น descendant ที่ positioned แบบ absolute ตามปกติ
const KEBAB_MENU_WIDTH = 200;
const KEBAB_MENU_EST_HEIGHT = 260;

function closeAllKebabs() {
  document.querySelectorAll('.kebab-menu.show').forEach((el) => el.classList.remove('show'));
  document.querySelectorAll('.btn-kebab[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function toggleKebab(btn) {
  const wrap = btn.closest('.kebab-wrap');
  const menu = wrap.querySelector('.kebab-menu');
  const wasOpen = menu.classList.contains('show');
  closeAllKebabs();
  if (wasOpen) return;

  const rect = btn.getBoundingClientRect();

  let top = rect.bottom + 4;
  let openUpward = false;
  if (top + KEBAB_MENU_EST_HEIGHT > window.innerHeight) {
    top = Math.max(4, rect.top - KEBAB_MENU_EST_HEIGHT - 4); // ล้นขอบล่าง → เปิดขึ้นบนแทน
    openUpward = true;
  }
  let left = rect.right - KEBAB_MENU_WIDTH;
  left = Math.max(4, Math.min(left, window.innerWidth - KEBAB_MENU_WIDTH - 4));

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.transformOrigin = openUpward ? 'bottom right' : 'top right';
  menu.classList.add('show');
  btn.setAttribute('aria-expanded', 'true');
}

function onActionClick(btn) {
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const name = btn.dataset.name;

  if (action === 'log') return openLogModal(`Log — ${name}`, id, false);
  if (action === 'edit-meta') return openEditMetaModal(name);
  if (action === 'config') return openConfigModal(name, id);
  if (action === 'remove') return openRemoveModal(id, name);
  if (action === 'tunnel-add') return openAttachTunnelModal(name);
  if (action === 'tunnel-log') return openLogModal(`Tunnel Log — ${name}`, name, true);
  if (action === 'tunnel-remove') return runDetachTunnel(name, btn);
  return runBotAction(action, id, btn);
}

async function runDetachTunnel(name, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'กำลังลบ...';
  try {
    await apiDetachTunnel(name);
    showToast(`ลบ tunnel ของ "${name}" สำเร็จ`, 'success');
  } catch (err) {
    showToast(`ลบ tunnel ของ "${name}" ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    loadBots();
  }
}

async function runBotAction(action, id, btn) {
  const labels = { start: 'เริ่ม', stop: 'หยุด', restart: 'รีสตาร์ท' };
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'กำลังทำงาน...';
  try {
    await apiBotAction(id, action);
    showToast(`${labels[action] || action} bot สำเร็จ`, 'success');
  } catch (err) {
    showToast(`${labels[action] || action} bot ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    loadBots();
  }
}

// ── Log modal ──
async function openLogModal(title, idOrName, isTunnel) {
  logModalTitle.textContent = title;
  logModalBody.textContent = 'Loading...';
  logModal.classList.add('show');
  try {
    const lines = isTunnel ? await apiGetTunnelLogs(idOrName) : await apiGetBotLogs(idOrName);
    logModalBody.textContent = lines.length ? lines.join('\n') : '(ไม่มี log)';
  } catch (err) {
    logModalBody.textContent = 'โหลด log ไม่สำเร็จ';
  }
}

function closeLogModal() {
  logModal.classList.remove('show');
}

// ── Create bot modal ──
function nextFreePort() {
  const used = new Set(botsCache.map((b) => b.port).filter(Boolean));
  let p = 3100;
  while (used.has(p)) p++;
  return p;
}

function openCreateModal() {
  createError.classList.remove('show');
  newBotName.value = '';
  newBotName.classList.remove('error');
  newBotPort.value = nextFreePort();
  newBotPort.classList.remove('error');
  newBotToken.value = '';
  newBotToken.classList.remove('error');
  newBotCompany.value = '';
  createModal.classList.add('show');
  newBotName.focus();
}

function closeCreateModal() {
  createModal.classList.remove('show');
}

async function submitCreateBot() {
  createError.classList.remove('show');
  newBotName.classList.remove('error');
  newBotPort.classList.remove('error');
  newBotToken.classList.remove('error');

  const name = newBotName.value.trim();
  const port = parseInt(newBotPort.value, 10);
  const tunnelToken = newBotToken.value.trim();
  const companyName = newBotCompany.value.trim();

  if (!NAME_RE.test(name)) {
    createError.textContent = 'ชื่อ bot ไม่ถูกต้อง — ใช้ได้เฉพาะ a-z, 0-9, - (2-31 ตัวอักษร)';
    createError.classList.add('show');
    newBotName.classList.add('error');
    return;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    createError.textContent = 'Port ไม่ถูกต้อง — ต้องเป็นตัวเลข 1024-65535';
    createError.classList.add('show');
    newBotPort.classList.add('error');
    return;
  }
  if (tunnelToken && !isValidTunnelToken(tunnelToken)) {
    createError.textContent = 'Token ไม่ถูกต้อง — ต้องยาวกว่า 20 ตัวอักษร และห้ามมีช่องว่าง';
    createError.classList.add('show');
    newBotToken.classList.add('error');
    return;
  }

  createSubmitBtn.disabled = true;
  createSubmitBtn.textContent = 'กำลังสร้าง...';
  try {
    await apiCreateBot({ name, port, tunnelToken: tunnelToken || undefined, companyName: companyName || undefined });
    createModal.classList.remove('show');
    showToast(`สร้าง bot "${name}" สำเร็จ`, 'success');
    loadBots();
  } catch (err) {
    createError.textContent = err.message;
    createError.classList.add('show');
  } finally {
    createSubmitBtn.disabled = false;
    createSubmitBtn.textContent = 'สร้าง';
  }
}

// ── Attach tunnel modal ──
function openAttachTunnelModal(name) {
  attachTunnelTarget = name;
  attachTunnelTitle.textContent = `เพิ่ม Tunnel — ${name}`;
  attachTunnelError.classList.remove('show');
  attachTunnelToken.value = '';
  attachTunnelToken.classList.remove('error');
  attachTunnelModal.classList.add('show');
  attachTunnelToken.focus();
}

function closeAttachTunnelModal() {
  attachTunnelModal.classList.remove('show');
}

async function submitAttachTunnel() {
  if (!attachTunnelTarget) return;
  attachTunnelError.classList.remove('show');
  attachTunnelToken.classList.remove('error');

  const token = attachTunnelToken.value.trim();
  if (!isValidTunnelToken(token)) {
    attachTunnelError.textContent = 'Token ไม่ถูกต้อง — ต้องยาวกว่า 20 ตัวอักษร และห้ามมีช่องว่าง';
    attachTunnelError.classList.add('show');
    attachTunnelToken.classList.add('error');
    return;
  }

  attachTunnelSubmitBtn.disabled = true;
  attachTunnelSubmitBtn.textContent = 'กำลังเพิ่ม...';
  try {
    await apiAttachTunnel(attachTunnelTarget, token);
    attachTunnelModal.classList.remove('show');
    showToast(`เพิ่ม tunnel ให้ "${attachTunnelTarget}" สำเร็จ`, 'success');
    loadBots();
  } catch (err) {
    attachTunnelError.textContent = err.message;
    attachTunnelError.classList.add('show');
  } finally {
    attachTunnelSubmitBtn.disabled = false;
    attachTunnelSubmitBtn.textContent = 'เพิ่ม Tunnel';
  }
}

// ── Edit customer meta modal ──
async function openEditMetaModal(name) {
  editMetaTarget = name;
  editMetaTitle.textContent = `แก้ไขข้อมูลลูกค้า — ${name}`;
  editMetaError.classList.remove('show');
  editCompanyName.value = '';
  editContactName.value = '';
  editContactPhone.value = '';
  editContractEnd.value = '';
  editNote.value = '';
  editCreatedAtDisplay.textContent = '-';
  editMetaModal.classList.add('show');
  try {
    const meta = await apiGetMeta(name);
    editCompanyName.value = meta.companyName || '';
    editContactName.value = meta.contactName || '';
    editContactPhone.value = meta.contactPhone || '';
    editContractEnd.value = meta.contractEnd || '';
    editNote.value = meta.note || '';
    editCreatedAtDisplay.textContent = meta.createdAt ? new Date(meta.createdAt).toLocaleString('th-TH') : '-';
  } catch (err) {
    editMetaError.textContent = `โหลดข้อมูลไม่สำเร็จ: ${err.message}`;
    editMetaError.classList.add('show');
  }
}

function closeEditMetaModal() {
  editMetaModal.classList.remove('show');
}

async function submitEditMeta() {
  if (!editMetaTarget) return;
  editMetaError.classList.remove('show');

  editMetaSubmitBtn.disabled = true;
  editMetaSubmitBtn.textContent = 'กำลังบันทึก...';
  try {
    await apiUpdateMeta(editMetaTarget, {
      companyName: editCompanyName.value.trim(),
      contactName: editContactName.value.trim(),
      contactPhone: editContactPhone.value.trim(),
      contractEnd: editContractEnd.value.trim(),
      note: editNote.value.trim(),
    });
    editMetaModal.classList.remove('show');
    showToast(`บันทึกข้อมูลลูกค้า "${editMetaTarget}" สำเร็จ`, 'success');
    loadBots();
  } catch (err) {
    editMetaError.textContent = err.message;
    editMetaError.classList.add('show');
  } finally {
    editMetaSubmitBtn.disabled = false;
    editMetaSubmitBtn.textContent = 'บันทึก';
  }
}

// ── Bot config modal (.env) ──
const CONFIG_GROUPS = [
  {
    key: 'line',
    label: 'LINE',
    fields: [
      { key: 'LINE_CHANNEL_SECRET', label: 'Channel Secret', secret: true },
      { key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'Channel Access Token', secret: true },
    ],
    guide: `
      <ol>
        <li>เปิด <a href="https://developers.line.biz" target="_blank" rel="noopener">developers.line.biz</a> → เลือก Provider → เลือก Channel</li>
        <li>แท็บ "Basic settings" → Channel secret</li>
        <li>แท็บ "Messaging API" → Channel access token (long-lived) → กด Issue ถ้ายังไม่มี</li>
      </ol>
    `,
  },
  {
    key: 'zabbix',
    label: 'Zabbix',
    testable: true, testSystem: 'zabbix',
    fields: [
      { key: 'ZABBIX_URL', label: 'Zabbix URL', url: true, placeholder: 'https://zabbix.example.com' },
      { key: 'ZABBIX_API_TOKEN', label: 'API Token', secret: true },
    ],
    guide: `
      <ol>
        <li>URL ของ Zabbix web interface เช่น https://192.168.1.10 (ไม่ต้องใส่ /api_jsonrpc.php)</li>
        <li>Login Zabbix → คลิกชื่อ User มุมบนขวา → "User settings" → แท็บ "API tokens"</li>
        <li>คลิก "Create API token" → ตั้งชื่อ → Copy Token ที่แสดง (แสดงครั้งเดียว!)</li>
      </ol>
    `,
  },
  {
    key: 'omada',
    label: 'Omada',
    testable: true, testSystem: 'omada',
    fields: [
      { key: 'OMADA_URL', label: 'Controller URL', url: true, placeholder: 'https://omada.example.com:8043' },
      { key: 'OMADA_OMADAC_ID', label: 'Omadac ID' },
      { key: 'OMADA_CLIENT_ID', label: 'Client ID' },
      { key: 'OMADA_CLIENT_SECRET', label: 'Client Secret', secret: true },
      { key: 'OMADA_SITE_ID', label: 'Site ID', placeholder: 'default' },
    ],
    guide: `
      <ol>
        <li>Cloud: https://&lt;region&gt;-omada-northbound.tplinkcloud.com &nbsp;/&nbsp; Local: https://&lt;ip&gt;:8043</li>
        <li>Login Omada → ดู URL จะเห็น /{omadacId}/ ต่อจาก port</li>
        <li>Settings → Platform Integration → Open API → Create → ตั้งชื่อ → Role: Administrator → เลือก Site → Save → copy Client ID/Secret</li>
        <li>Site ID: Settings → Open API → ดู URL หลัง /sites/ หรือใช้ "default"</li>
      </ol>
    `,
  },
  {
    key: 'hikcentral',
    label: 'HikCentral',
    testable: true, testSystem: 'hikcentral',
    fields: [
      { key: 'HIKCENTRAL_URL', label: 'HikCentral URL', url: true, placeholder: 'https://hikcentral.example.com' },
      { key: 'HIKCENTRAL_APP_KEY', label: 'App Key (AK)' },
      { key: 'HIKCENTRAL_APP_SECRET', label: 'App Secret (SK)', secret: true },
    ],
    guide: `
      <ol>
        <li>ติดตั้ง Artemis OpenAPI บน HikCentral Server จาก <a href="https://tpp.hikvision.com/tpp/Resource" target="_blank" rel="noopener">tpp.hikvision.com/tpp/Resource</a></li>
        <li>เปิด Artemis Web ที่ http://[server]:9017 → Login → User Management → สร้าง User → Copy AppKey/AppSecret</li>
        <li>Authorized API → เพิ่ม API ที่ต้องการ</li>
      </ol>
    `,
  },
  {
    key: 'ai',
    label: 'AI Provider',
    testable: true, // system อ่านจาก dropdown AI_PROVIDER ตอนกดปุ่ม
    fields: [
      { key: 'AI_PROVIDER', label: 'AI Provider', select: true, options: [
        { value: 'claude', label: 'Claude (Anthropic)' },
        { value: 'gemini', label: 'Gemini (Google)' },
        { value: 'openai', label: 'GPT (OpenAI)' },
      ] },
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', secret: true, providerFor: 'claude' },
      { key: 'GEMINI_API_KEY', label: 'Gemini API Key', secret: true, providerFor: 'gemini' },
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', secret: true, providerFor: 'openai' },
    ],
    guide: `
      <ol>
        <li>เลือก Provider ที่ต้องการใช้ — ถ้าไม่ตั้งค่าจะใช้ Claude เป็นค่าเริ่มต้นเสมอ</li>
        <li>ถ้าเลือก Gemini/GPT แต่ไม่ได้ใส่ API key ของเจ้านั้น ระบบจะ fallback กลับไปใช้ Claude อัตโนมัติ (ต้องมี Anthropic API Key ไว้เสมอ)</li>
        <li>Claude: <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a></li>
        <li>Gemini: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></li>
        <li>OpenAI: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a></li>
      </ol>
    `,
  },
];
const CONFIG_ALL_FIELDS = CONFIG_GROUPS.flatMap((g) => g.fields);

let configTarget = null;
let configOriginal = null;

function configFieldIsSet(cfg, field) {
  if (field.secret) return !!(cfg[field.key] && cfg[field.key].set);
  return !!(cfg[field.key] && cfg[field.key].trim());
}

function configGroupDone(cfg, group) {
  // กลุ่ม AI: แค่มี ANTHROPIC_API_KEY (fallback บังคับ) ก็ถือว่าตั้งค่าแล้ว —
  // Gemini/OpenAI key เป็น optional ไม่ต้องครบทุก field เหมือนกลุ่มอื่น
  if (group.key === 'ai') {
    return configFieldIsSet(cfg, { key: 'ANTHROPIC_API_KEY', secret: true });
  }
  return group.fields.every((f) => configFieldIsSet(cfg, f));
}

function renderConfigField(cfg, f) {
  const inputId = `cfg_${f.key}`;
  // field ที่ผูกกับ provider ตัวใดตัวหนึ่ง (providerFor) ซ่อนไว้ก่อนถ้าไม่ตรงกับ
  // AI_PROVIDER ปัจจุบัน — ซ่อนด้วย CSS (field-hidden) เท่านั้น ไม่ตัดออกจาก DOM
  // เพื่อให้ค่าที่กรอกไว้ก่อนสลับ provider ยังอยู่ และ buildConfigPayload อ่านได้ปกติ
  const providerFor = f.providerFor || '';
  const currentProvider = cfg.AI_PROVIDER || 'claude';
  const hiddenClass = (providerFor && providerFor !== currentProvider) ? ' field-hidden' : '';
  const providerAttr = ` data-provider-for="${providerFor}"`;

  if (f.select) {
    const current = cfg[f.key] || '';
    const options = f.options.map((o) => `<option value="${escapeHtml(o.value)}"${current === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `
      <div class="field${hiddenClass}"${providerAttr}>
        <label for="${inputId}">${f.label}</label>
        <select id="${inputId}" data-field="${f.key}">
          ${options}
        </select>
      </div>
    `;
  }
  if (f.secret) {
    const isSet = cfg[f.key] && cfg[f.key].set;
    const placeholder = isSet ? `${cfg[f.key].hint} (ตั้งค่าแล้ว เว้นว่างถ้าไม่แก้)` : '';
    return `
      <div class="field${hiddenClass}"${providerAttr}>
        <label for="${inputId}">${f.label}</label>
        <div class="input-wrap">
          <input type="password" id="${inputId}" data-field="${f.key}" autocomplete="new-password" placeholder="${escapeHtml(placeholder)}">
          <button type="button" class="toggle-vis" data-toggle-vis="${inputId}" title="แสดง/ซ่อน" tabindex="-1">&#128065;</button>
        </div>
        ${isSet ? `<button type="button" class="btn-clear-secret" data-clear-field="${f.key}">ล้างค่า</button>` : ''}
      </div>
    `;
  }
  const val = escapeHtml(cfg[f.key] || '');
  return `
    <div class="field${hiddenClass}"${providerAttr}>
      <label for="${inputId}">${f.label}</label>
      <input type="text" id="${inputId}" data-field="${f.key}" autocomplete="off" value="${val}" placeholder="${escapeHtml(f.placeholder || '')}">
    </div>
  `;
}

// เรียกตอน AI_PROVIDER dropdown เปลี่ยนค่า — toggle field-hidden ตาม provider ใหม่
// (ไม่ reload modal ทั้งก้อน แค่ toggle class บน field ที่มี data-provider-for)
function applyProviderFieldVisibility(provider) {
  configModalBody.querySelectorAll('[data-provider-for]').forEach((el) => {
    const wantedFor = el.dataset.providerFor;
    if (!wantedFor) return; // field ที่ไม่ได้ผูกกับ provider ไหน (data-provider-for="")
    el.classList.toggle('field-hidden', wantedFor !== provider);
  });
}

function renderConfigSections(cfg) {
  return CONFIG_GROUPS.map((group, i) => {
    const done = configGroupDone(cfg, group);
    return `
      <details class="config-section"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="config-section-title">${group.label}</span>
          <span class="config-badge ${done ? 'ok' : 'pending'}">${done ? 'พร้อมใช้ ✓' : 'ยังไม่พร้อม'}</span>
        </summary>
        <div class="config-section-body">
          ${group.fields.map((f) => renderConfigField(cfg, f)).join('')}
          ${group.testable ? `<div class="test-row"><button type="button" class="btn-test-connection" data-test-group="${group.key}"${group.testSystem ? ` data-test-system="${group.testSystem}"` : ''}>ทดสอบการเชื่อมต่อ</button><span class="test-result" data-test-result="${group.key}" aria-live="polite"></span></div>` : ''}
          <details class="guide-accordion">
            <summary>วิธีหาค่านี้ ?</summary>
            ${group.guide}
          </details>
        </div>
      </details>
    `;
  }).join('');
}

async function openConfigModal(name, id) {
  configTarget = { name, id };
  configOriginal = null;
  configModalTitle.textContent = `API — ${name}`;
  configModalError.classList.remove('show');
  configModalBody.innerHTML = 'Loading...';
  configModal.classList.add('show');
  configSaveBtn.disabled = false;
  configSaveBtn.textContent = 'บันทึก';
  configSaveRestartBtn.disabled = false;
  configSaveRestartBtn.textContent = 'บันทึกและ Restart bot';
  try {
    const cfg = await apiGetBotConfig(name);
    configOriginal = cfg;
    configModalBody.innerHTML = renderConfigSections(cfg);
    configModalBody.insertAdjacentHTML('beforeend', dailySummarySectionHtml());
    loadDailySummarySection(name);
  } catch (err) {
    configModalBody.innerHTML = `<div class="form-error show">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ── เวลาแจ้งเตือนสรุปประจำวัน (อยู่ใน config modal; บันทึกแยกจาก .env และมีผลทันทีไม่ต้อง restart) ──
// เก็บเป็นรายการ HH:mm เวลาไทย — server เป็นผู้ validate จริง (ฝั่งนี้ตรวจแค่ให้แจ้งเร็ว)
function dailySummarySectionHtml() {
  return `
    <details class="config-section" id="dsSection" open>
      <summary>
        <span class="config-section-title">สรุปปัญหาประจำวัน (แจ้งเตือนอัตโนมัติ)</span>
        <span class="config-badge pending" id="dsBadge">กำลังโหลด...</span>
      </summary>
      <div class="config-section-body">
        <p class="ds-hint">ส่งสรุปปัญหาให้ผู้ใช้ที่อนุมัติแล้วทุกคนตามเวลาด้านล่าง · เวลาไทย (Asia/Bangkok) 24 ชม. · บันทึกแล้วมีผลทันที ไม่ต้อง Restart bot</p>
        <div id="dsTimes" class="ds-times"></div>
        <div class="test-row">
          <button type="button" class="btn btn-secondary" id="dsAddBtn">+ เพิ่มเวลา</button>
          <button type="button" class="btn btn-teal" id="dsSaveBtn">บันทึกเวลา</button>
          <span class="test-result" id="dsResult" aria-live="polite"></span>
        </div>
        <div class="ds-live" id="dsLive"></div>
      </div>
    </details>
  `;
}

function dsRenderTimes(times) {
  const box = document.getElementById('dsTimes');
  if (!box) return;
  box.innerHTML = times.map((t) => `
    <div class="ds-time-row">
      <input type="time" data-ds-time value="${escapeHtml(t)}" step="60" required>
      <button type="button" class="btn btn-secondary ds-remove" data-ds-remove title="ลบเวลานี้">✕</button>
    </div>`).join('');
}

function dsCollectTimes() {
  return Array.from(document.querySelectorAll('#dsTimes [data-ds-time]')).map((el) => el.value);
}

function dsSetResult(text, kind) {
  const el = document.getElementById('dsResult');
  if (!el) return;
  el.textContent = text;
  el.className = `test-result${kind ? ' ' + kind : ''}`;
}

function dsRenderLive(live, saved) {
  const el = document.getElementById('dsLive');
  const badge = document.getElementById('dsBadge');
  if (!el || !badge) return;
  let text;
  let state = 'pending';
  if (!live || !live.reachable) {
    text = 'bot ไม่ได้ทำงานอยู่ — เวลาที่บันทึกจะใช้ตอน bot start';
  } else if (!live.supported) {
    text = 'bot ใช้ image เก่า ยังไม่รองรับการตั้งเวลา — ต้องอัปเดต image และ recreate bot';
  } else {
    const next = live.nextRun ? new Date(live.nextRun).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    text = `bot ใช้อยู่ตอนนี้: ${(live.times || []).join(', ')} · รอบถัดไป ${next}`;
    state = 'ok';
  }
  el.textContent = text;
  badge.textContent = state === 'ok' ? 'ใช้งานอยู่ ✓' : 'รอ bot';
  badge.className = `config-badge ${state}`;
  if (saved && saved.invalid) el.textContent += ` (ค่าในไฟล์ไม่ถูกต้อง: ${saved.invalid})`;
}

async function loadDailySummarySection(name) {
  try {
    const data = await apiGetDailySummary(name);
    if (!configTarget || configTarget.name !== name) return; // modal ถูกปิด/เปลี่ยน bot ระหว่างรอ
    dsRenderTimes(data.times);
    dsRenderLive(data.live, data);
  } catch (err) {
    dsSetResult(`โหลดไม่สำเร็จ: ${err.message}`, 'error');
  }
  const section = document.getElementById('dsSection');
  if (!section) return;
  section.querySelector('#dsAddBtn').addEventListener('click', () => {
    dsRenderTimes([...dsCollectTimes(), '12:00']);
  });
  section.querySelector('#dsTimes').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-ds-remove]');
    if (!rm) return;
    rm.closest('.ds-time-row').remove();
  });
  section.querySelector('#dsSaveBtn').addEventListener('click', async () => {
    const times = dsCollectTimes();
    if (times.length === 0) return dsSetResult('ต้องมีเวลาอย่างน้อย 1 ค่า', 'error');
    if (times.some((t) => !t)) return dsSetResult('มีช่องเวลาที่ยังไม่ได้กรอก', 'error');
    if (new Set(times).size !== times.length) return dsSetResult('มีเวลาซ้ำกัน', 'error');
    const btn = document.getElementById('dsSaveBtn');
    btn.disabled = true;
    dsSetResult('กำลังบันทึก...', '');
    try {
      const r = await apiSaveDailySummary(name, times);
      dsRenderTimes(r.times);
      dsRenderLive(r.live, null);
      dsSetResult(r.note, r.applied ? 'ok' : 'info');
    } catch (err) {
      dsSetResult(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function closeConfigModal() {
  configModal.classList.remove('show');
  // ล้าง DOM ทั้งก้อนตอนปิด — กัน secret ที่พิมพ์ไว้ค้างอยู่ใน input หลังปิด modal
  configModalBody.innerHTML = '';
  configTarget = null;
  configOriginal = null;
}

function toggleClearSecret(btn) {
  const key = btn.dataset.clearField;
  const input = configModalBody.querySelector(`input[data-field="${key}"]`);
  if (!input) return;
  const pending = input.dataset.pendingClear === '1';
  if (pending) {
    input.dataset.pendingClear = '';
    input.disabled = false;
    const original = configOriginal && configOriginal[key];
    input.placeholder = original && original.set ? `${original.hint} (ตั้งค่าแล้ว เว้นว่างถ้าไม่แก้)` : '';
    btn.textContent = 'ล้างค่า';
  } else {
    input.value = '';
    input.dataset.pendingClear = '1';
    input.disabled = true;
    input.placeholder = '(จะลบค่านี้เมื่อบันทึก)';
    btn.textContent = 'เลิกล้างค่า';
  }
}

// ── ทดสอบการเชื่อมต่อ (ต่อกลุ่ม) ──
// จับคู่ field ของแต่ละกลุ่มกับชื่อ key ที่ LineBot /test-connection ต้องการ
const TEST_FIELD_MAP = {
  zabbix: { ZABBIX_URL: 'url', ZABBIX_API_TOKEN: 'apiToken' },
  omada: {
    OMADA_URL: 'url', OMADA_OMADAC_ID: 'omadacId', OMADA_CLIENT_ID: 'clientId',
    OMADA_CLIENT_SECRET: 'clientSecret', OMADA_SITE_ID: 'siteId',
  },
  hikcentral: { HIKCENTRAL_URL: 'url', HIKCENTRAL_APP_KEY: 'appKey', HIKCENTRAL_APP_SECRET: 'appSecret' },
  claude: { ANTHROPIC_API_KEY: 'apiKey' },
  gemini: { GEMINI_API_KEY: 'apiKey' },
  openai: { OPENAI_API_KEY: 'apiKey' },
};

// คืน { system, config } หรือ { warn } เมื่อมี secret ที่ frontend ไม่รู้ค่าจริง (ยังไม่กรอกใหม่)
function buildTestRequest(btn) {
  let system = btn.dataset.testSystem;
  if (!system) {
    const sel = configModalBody.querySelector('select[data-field="AI_PROVIDER"]');
    system = (sel && sel.value) || 'claude';
  }
  const map = TEST_FIELD_MAP[system];
  const cfg = {};
  for (const [envKey, name] of Object.entries(map)) {
    const field = CONFIG_ALL_FIELDS.find((f) => f.key === envKey);
    const input = configModalBody.querySelector(`[data-field="${envKey}"]`);
    const value = input && !input.disabled ? input.value.trim() : '';
    if (field.secret && value === '') {
      const orig = configOriginal && configOriginal[envKey];
      if (orig && orig.set && !(input && input.dataset.pendingClear === '1')) {
        return { warn: 'ทดสอบด้วยค่าที่บันทึกไว้แล้วไม่ได้ กรุณากรอกค่าใหม่ก่อนทดสอบ' };
      }
    }
    if (value !== '') cfg[name] = value;
  }
  if (Object.keys(cfg).length === 0) return { warn: 'กรุณากรอกค่าก่อนทดสอบ' };
  return { system, config: cfg };
}

function setTestResult(el, kind, text, spinner) {
  el.className = `test-result ${kind}`;
  el.textContent = '';
  if (spinner) {
    const sp = document.createElement('span');
    sp.className = 'test-spinner';
    el.appendChild(sp);
  }
  el.appendChild(document.createTextNode(text));
}

async function runConnectionTest(btn) {
  const resultEl = configModalBody.querySelector(`[data-test-result="${btn.dataset.testGroup}"]`);
  if (!resultEl || !configTarget) return;
  const req = buildTestRequest(btn);
  if (req.warn) {
    setTestResult(resultEl, 'info', req.warn);
    return;
  }
  const target = configTarget;
  btn.disabled = true;
  setTestResult(resultEl, 'pending', 'กำลังทดสอบ...', true);
  try {
    const r = await apiTestConnection(target.id, req.system, req.config);
    if (configTarget !== target) return; // modal ถูกปิด/เปลี่ยน bot ระหว่างรอ
    setTestResult(resultEl, r.ok ? 'ok' : 'error', `${r.ok ? '✓' : '✗'} ${r.message || ''}`);
  } catch (err) {
    if (configTarget === target) setTestResult(resultEl, 'error', '✗ ทดสอบไม่สำเร็จ ลองใหม่อีกครั้ง');
  } finally {
    btn.disabled = false;
  }
}

function buildConfigPayload() {
  const payload = {};
  CONFIG_ALL_FIELDS.forEach((f) => {
    // ใช้ selector กว้างที่จับได้ทั้ง <input> และ <select> — ทั้งคู่มี .value
    // เหมือนกัน ไม่ต้องแยก branch ตาม tagName
    const input = configModalBody.querySelector(`[data-field="${f.key}"]`);
    if (!input) return;
    if (f.secret) {
      if (input.dataset.pendingClear === '1') {
        payload[f.key] = null;
        return;
      }
      if (input.value !== '') payload[f.key] = input.value;
      return;
    }
    const v = input.value.trim();
    const orig = (configOriginal && configOriginal[f.key]) || '';
    if (v !== orig) payload[f.key] = v;
  });
  return payload;
}

async function submitConfigModal(restart) {
  if (!configTarget) return;
  configModalError.classList.remove('show');

  const payload = buildConfigPayload();
  if (Object.keys(payload).length === 0 && !restart) {
    showToast('ไม่มีการเปลี่ยนแปลงให้บันทึก', 'info');
    return;
  }

  const btn = restart ? configSaveRestartBtn : configSaveBtn;
  const otherBtn = restart ? configSaveBtn : configSaveRestartBtn;
  const originalText = btn.textContent;
  btn.disabled = true;
  otherBtn.disabled = true;
  btn.textContent = 'กำลังบันทึก...';

  try {
    if (Object.keys(payload).length > 0) {
      await apiSaveBotConfig(configTarget.name, payload);
    }
    if (restart) {
      btn.textContent = 'กำลัง Restart...';
      await apiBotAction(configTarget.id, 'restart');
      showToast(`บันทึกและ Restart "${configTarget.name}" สำเร็จ`, 'success');
    } else {
      showToast(`บันทึกการตั้งค่า "${configTarget.name}" สำเร็จ — ค่าใหม่จะมีผลหลัง Restart`, 'success');
    }
    closeConfigModal();
    loadBots();
  } catch (err) {
    configModalError.textContent = err.message;
    configModalError.classList.add('show');
  } finally {
    btn.disabled = false;
    otherBtn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Remove confirm modal ──
function openRemoveModal(id, name) {
  removeTarget = { id, name };
  const bot = botsCache.find((b) => b.id === id);
  const hasTunnel = !!(bot && bot.tunnel && bot.tunnel.exists);
  removeConfirmText.textContent = hasTunnel
    ? `ยืนยันการลบ bot "${name}" ? จะลบ Cloudflare Tunnel ของบอทนี้ไปด้วย การลบ container ไม่สามารถย้อนกลับได้`
    : `ยืนยันการลบ bot "${name}" ? การลบ container ไม่สามารถย้อนกลับได้`;
  removeDeleteFiles.checked = false;
  removeModal.classList.add('show');
}

function closeRemoveModal() {
  removeModal.classList.remove('show');
}

async function submitRemoveBot() {
  if (!removeTarget) return;
  const { id, name } = removeTarget;
  const deleteFiles = removeDeleteFiles.checked;

  removeConfirmBtn.disabled = true;
  removeConfirmBtn.textContent = 'กำลังลบ...';
  try {
    await apiRemoveBot(id, deleteFiles);
    removeModal.classList.remove('show');
    showToast(`ลบ bot "${name}" สำเร็จ${deleteFiles ? ' (รวมไฟล์)' : ''}`, 'success');
    loadBots();
  } catch (err) {
    showToast(`ลบ bot "${name}" ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    removeConfirmBtn.disabled = false;
    removeConfirmBtn.textContent = 'ลบ';
  }
}

// ── Stats detail modal ──
function fmtTs(ts) {
  return new Date(ts * 1000).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function pctText(pct) {
  return pct === null || pct === undefined ? '—' : `${pct.toFixed(1)}%`;
}

async function openStatsModal(name) {
  statsModalTitle.textContent = `สถิติ — ${name}`;
  statsModalBody.innerHTML = 'Loading...';
  statsModal.classList.add('show');
  try {
    const [summary, daily, samples] = await Promise.all([
      apiGetStatsSummary(name),
      apiGetStatsDaily(name, 30),
      apiGetStatsSamples(name, 24),
    ]);
    renderStatsModal(summary, daily, samples);
  } catch (err) {
    statsModalBody.innerHTML = `<div class="form-error show">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function closeStatsModal() {
  statsModal.classList.remove('show');
}

function renderStatsModal(summary, daily, samples) {
  statsModalBody.innerHTML = `
    <div class="stat-big-row">
      <div class="stat-big-card"><div class="stat-big-label">24 ชม.</div><div class="stat-big-number">${pctText(summary.last24h)}</div></div>
      <div class="stat-big-card"><div class="stat-big-label">7 วัน</div><div class="stat-big-number">${pctText(summary.last7d)}</div></div>
      <div class="stat-big-card"><div class="stat-big-label">30 วัน</div><div class="stat-big-number">${pctText(summary.last30d)}</div></div>
    </div>
    <div class="stat-chart-section">
      <div class="stat-chart-title">Uptime รายวัน (30 วัน)</div>
      <div class="stat-chart-wrap"><canvas id="uptimeChartCanvas"></canvas></div>
    </div>
    <div class="stat-chart-section">
      <div class="stat-chart-title">Problems (24 ชั่วโมงล่าสุด)</div>
      <div class="stat-chart-wrap"><canvas id="problemsChartCanvas"></canvas></div>
    </div>
    <div class="stat-chart-section">
      <div class="stat-chart-title">Sample ล่าสุด</div>
      <table class="stat-table">
        <thead><tr><th>เวลา</th><th>สถานะ</th><th>Problems</th></tr></thead>
        <tbody>
          ${samples.slice(-10).reverse().map((s) => `
            <tr>
              <td>${fmtTs(s.ts)}</td>
              <td><span class="state-pill"><span class="state-dot ${s.state}"></span>${STATE_LABEL[s.state] || s.state}</span></td>
              <td>${s.problems_total ?? '—'}</td>
            </tr>
          `).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-dim);">ไม่มีข้อมูล</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  if (uptimeChart) { uptimeChart.destroy(); uptimeChart = null; }
  if (problemsChart) { problemsChart.destroy(); problemsChart = null; }

  const uptimeCtx = document.getElementById('uptimeChartCanvas');
  if (uptimeCtx && window.Chart) {
    uptimeChart = new Chart(uptimeCtx, {
      type: 'line',
      data: {
        labels: daily.map((d) => d.day.slice(5)),
        datasets: [{
          label: 'Uptime %',
          data: daily.map((d) => d.uptime_pct),
          borderColor: '#00d4a0',
          backgroundColor: 'rgba(0,212,160,.12)',
          fill: true,
          tension: 0.25,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#8b96a8' } },
          y: { min: 0, max: 100, ticks: { color: '#8b96a8', callback: (v) => v + '%' }, grid: { color: 'rgba(255,255,255,.05)' } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  const problemsCtx = document.getElementById('problemsChartCanvas');
  if (problemsCtx && window.Chart) {
    problemsChart = new Chart(problemsCtx, {
      type: 'line',
      data: {
        labels: samples.map((s) => new Date(s.ts * 1000).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })),
        datasets: [{
          label: 'Problems',
          data: samples.map((s) => s.problems_total),
          borderColor: '#7c6cf6',
          backgroundColor: 'rgba(124,108,246,.12)',
          fill: true,
          tension: 0.25,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#8b96a8' } },
          y: { beginAtZero: true, ticks: { color: '#8b96a8', precision: 0 }, grid: { color: 'rgba(255,255,255,.05)' } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
}

// ── Update image ──
async function submitPullImage(btn) {
  btn.disabled = true;
  btn.textContent = 'กำลังอัปเดต...';
  try {
    await apiPullImage();
    // pull image เข้า local cache เฉยๆ ไม่ได้สลับ container ที่รันอยู่ไปใช้ image ใหม่
    // (Docker ผูก container กับ image ID ตอน create ไม่ใช่ตอน start/restart) — เตือนให้ชัด
    // ว่า restart อย่างเดียวไม่พอ ต้อง "ลบแล้วสร้างใหม่" เท่านั้น ใช้ duration ยาวกว่าปกติ
    // เพราะข้อความยาว อ่านทันด้วย type 'info'
    showToast(
      'Pull image สำเร็จ — bot ที่ต้องการใช้เวอร์ชันใหม่ต้อง "ลบแล้วสร้างใหม่" (ไม่ใช่แค่ Restart) กด ⋯ → ลบ Bot (ไม่ลบไฟล์) แล้วสร้างใหม่ด้วยชื่อ/port เดิม',
      'info',
      9000
    );
  } catch (err) {
    showToast(`อัปเดต image ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'อัปเดต Image';
  }
}

async function submitLogout() {
  await apiLogout();
  window.location.href = '/login.html';
}
