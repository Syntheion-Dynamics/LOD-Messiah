const kitsEl = document.getElementById('kits');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const cookBtn = document.getElementById('cook');
const jobsEl = document.getElementById('jobs');

let jobId = null;
let logOffset = 0;
let pollTimer = null;
let viewLog = '';

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function selectedKits() {
  return [...kitsEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (el) => el.value,
  );
}

function lodPayload() {
  return {
    lod0: document.getElementById('lod0').checked,
    lod1: document.getElementById('lod1').checked,
    lod2Atlas: document.getElementById('lod2Atlas').checked,
    lod3: document.getElementById('lod3').checked,
    jobs: Number(jobsEl.value) || 4,
  };
}

function renderKits(kits) {
  if (!kits.length) {
    kitsEl.innerHTML =
      '<div class="empty">Žádné kity. Zkontroluj složku <code>Kitbash Assets/</code>.</div>';
    return;
  }
  kitsEl.innerHTML = kits
    .map(
      (k) => `
      <label>
        <input type="checkbox" value="${escapeAttr(k.name)}" />
        <span>${escapeHtml(k.name)}</span>
        <span class="hint">${k.assetCount ?? 0} assetů</span>
      </label>`,
    )
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function setAllChecks(root, on) {
  root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.checked = on;
  });
}

async function loadKits() {
  const res = await fetch('/api/kits');
  if (!res.ok) throw new Error(`API kits ${res.status}`);
  const data = await res.json();
  if (data.missing) {
    metaEl.textContent = `Chybí ${data.kitsRoot}`;
  } else {
    metaEl.textContent = `${data.kits.length} kitů · ${data.kitsRoot}`;
  }
  renderKits(data.kits || []);
}

function appendViewLog(chunk) {
  if (!chunk) return;
  viewLog += chunk;
  logEl.textContent = viewLog;
  logEl.scrollTop = logEl.scrollHeight;
}

async function pollLog() {
  if (!jobId) return;
  try {
    const res = await fetch(`/api/log?jobId=${encodeURIComponent(jobId)}&from=${logOffset}`);
    if (!res.ok) return;
    const data = await res.json();
    const job = data.job;
    if (!job) return;
    if (job.log) {
      appendViewLog(job.log);
      logOffset = (job.logOffset || 0) + job.log.length;
    }
    if (job.running) {
      setStatus(`Běží ${job.mode}… (${job.kits.join(', ')})`, 'run');
      cookBtn.disabled = true;
    } else {
      cookBtn.disabled = false;
      if (job.exitCode === 0) {
        setStatus(`Hotovo (${job.mode}, exit 0).`, 'ok');
      } else {
        setStatus(`Selhalo (${job.mode}, exit ${job.exitCode}).`, 'bad');
      }
      stopPoll();
    }
  } catch {
    // ignore transient poll errors
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(pollLog, 1000);
  pollLog();
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startCook() {
  const kits = selectedKits();
  if (!kits.length) {
    setStatus('Vyber aspoň jeden kit.', 'bad');
    return;
  }
  const lods = lodPayload();
  if (!lods.lod0 && !lods.lod1 && !lods.lod2Atlas && !lods.lod3) {
    setStatus('Zaškrtni aspoň jeden LOD.', 'bad');
    return;
  }

  cookBtn.disabled = true;
  setStatus('Spouštím…', 'run');
  viewLog = '';
  logEl.textContent = '';
  logOffset = 0;

  const res = await fetch('/api/cook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kits, ...lods }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    cookBtn.disabled = false;
    setStatus(data.error || `Chyba ${res.status}`, 'bad');
    return;
  }
  jobId = data.job.id;
  appendViewLog(`[ui] job ${jobId}\n[ui] ${data.job.command}\n\n`);
  startPoll();
}

document.getElementById('kitsAll').addEventListener('click', () => {
  setAllChecks(kitsEl, true);
});
document.getElementById('kitsNone').addEventListener('click', () => {
  setAllChecks(kitsEl, false);
});
document.getElementById('lodsAll').addEventListener('click', () => {
  ['lod0', 'lod1', 'lod2Atlas', 'lod3'].forEach((id) => {
    document.getElementById(id).checked = true;
  });
});
document.getElementById('lodsNone').addEventListener('click', () => {
  ['lod0', 'lod1', 'lod2Atlas', 'lod3'].forEach((id) => {
    document.getElementById(id).checked = false;
  });
});
document.getElementById('clearLog').addEventListener('click', () => {
  viewLog = '';
  logEl.textContent = '';
});
cookBtn.addEventListener('click', () => {
  startCook().catch((err) => {
    cookBtn.disabled = false;
    setStatus(err.message, 'bad');
  });
});

loadKits().catch((err) => {
  metaEl.textContent = err.message;
  setStatus(err.message, 'bad');
});
