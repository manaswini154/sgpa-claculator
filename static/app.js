// ── state ──────────────────────────────────────────
let extractedSubjects = [];

// ── upload zone ────────────────────────────────────
const zone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');

zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
zone.addEventListener('drop', e => {
  e.preventDefault(); zone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
zone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

function handleFile(file) {
  if (!file.type.startsWith('image/')) { showError('upload-error', 'Please upload an image file.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('preview-img');
    img.src = e.target.result;
    img.classList.remove('hidden');
    zone.style.padding = '16px';
    document.getElementById('upload-actions').classList.remove('hidden');
    hideError('upload-error');
  };
  reader.readAsDataURL(file);
}

function resetUpload() {
  document.getElementById('preview-img').classList.add('hidden');
  document.getElementById('preview-img').src = '';
  zone.style.padding = '';
  document.getElementById('upload-actions').classList.add('hidden');
  fileInput.value = '';
}

// ── extract grades ──────────────────────────────────
async function extractGrades() {
  const file = fileInput.files[0];
  if (!file) { showError('upload-error', 'Please select an image first.'); return; }

  setLoading('extract-btn', 'extract-label', 'Analysing…', true);
  hideError('upload-error');

  const form = new FormData();
  form.append('image', file);

  try {
    const res = await fetch('/extract', { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) { showError('upload-error', data.error); return; }

    extractedSubjects = data.subjects || [];
    if (!extractedSubjects.length) { showError('upload-error', 'No subjects found. Make sure both tables are visible in the screenshot.'); return; }

    renderSubjects(extractedSubjects);
    document.getElementById('section-upload').classList.add('hidden');
    document.getElementById('section-confirm').classList.remove('hidden');
  } catch (e) {
    showError('upload-error', 'Connection error. Make sure the Flask server is running on port 5000.');
  } finally {
    setLoading('extract-btn', 'extract-label', 'Analyse with AI', false);
  }
}

// ── render subject cards ────────────────────────────
function renderSubjects(subjects) {
  const container = document.getElementById('subjects-list');
  container.innerHTML = '';

  subjects.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'subject-card';
    card.id = `sc-${i}`;

    const isSmall = s.credits <= 2;
    const gradesHtml = buildGradesHtml(s);

    card.innerHTML = `
      <div class="sc-top">
        <div>
          <div class="sc-name">${s.name}</div>
          <div class="sc-code">${s.courseCode || ''} &nbsp;·&nbsp; ${s.courseType || 'TP'}</div>
        </div>
        <div class="sc-right">
          <select class="credits-select" id="cr-${i}" title="Credits">
            ${[1,2,3,4].map(c => `<option value="${c}"${c==s.credits?' selected':''}>${c} cr</option>`).join('')}
          </select>
          <label class="abs-toggle" title="Absolute grading means LE/CE column shows marks (e.g. 88) instead of a letter grade">
            <input type="checkbox" id="abs-${i}" onchange="toggleAbsolute(${i})">
            Absolute grading
          </label>
        </div>
      </div>
      <div class="sc-grades" id="grades-${i}">${gradesHtml}</div>
      <div class="abs-input" id="abs-input-${i}">
        <label>LE / CE Marks (out of 100)</label>
        <input type="number" id="abs-marks-${i}" min="0" max="100" placeholder="e.g. 88" value="${s.leGrade && !isNaN(s.leGrade) ? s.leGrade : ''}">
      </div>`;

    container.appendChild(card);

    // auto-detect: if leGrade is a number, pre-check absolute
    if (s.leGrade && !isNaN(s.leGrade)) {
      document.getElementById(`abs-${i}`).checked = true;
      toggleAbsolute(i);
    }
  });
}

function buildGradesHtml(s) {
  const parts = [];
  if (s.s1Grade) parts.push(`<div class="sc-grade">S1 (Mid) <span class="pill">${s.s1Grade}</span></div>`);
  if (s.s2Grade) parts.push(`<div class="sc-grade">S2 (Sem) <span class="pill">${s.s2Grade}</span></div>`);
  if (s.leGrade) parts.push(`<div class="sc-grade">LE/CE <span class="pill">${s.leGrade}</span></div>`);
  if (s.hasLab && s.labMarks != null) parts.push(`<div class="sc-grade">Lab <span class="pill">${s.labMarks}/100</span></div>`);
  return parts.join('') || '<div class="sc-grade" style="color:#999">No grade data extracted</div>';
}

function toggleAbsolute(i) {
  const checked = document.getElementById(`abs-${i}`).checked;
  const card = document.getElementById(`sc-${i}`);
  const absInput = document.getElementById(`abs-input-${i}`);
  card.classList.toggle('absolute-mode', checked);
  absInput.style.display = checked ? 'block' : 'none';
}

// ── calculate ───────────────────────────────────────
async function calculateSGPA() {
  hideError('confirm-error');

  const currentCGPA = parseFloat(document.getElementById('current-cgpa').value) || 0;
  const currentCredits = parseInt(document.getElementById('current-credits').value) || 0;

  const subjects = extractedSubjects.map((s, i) => {
    const isAbs = document.getElementById(`abs-${i}`).checked;
    const credits = parseInt(document.getElementById(`cr-${i}`).value);
    const out = { ...s, credits, isAbsolute: isAbs, hasLab: s.hasLab || false };
    if (isAbs) {
      out.leMarks = parseFloat(document.getElementById(`abs-marks-${i}`).value) || 0;
    }
    return out;
  });

  setLoading('calc-btn', 'calc-label', 'Calculating…', true, false);

  try {
    const res = await fetch('/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjects, currentCGPA, currentCredits })
    });
    const data = await res.json();
    if (data.error) { showError('confirm-error', data.error); return; }

    renderResults(data);
    document.getElementById('section-confirm').classList.add('hidden');
    document.getElementById('section-results').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    showError('confirm-error', 'Server error. Is Flask running?');
  } finally {
    setLoading('calc-btn', 'calc-label', 'Calculate SGPA', false, false);
  }
}

function renderResults(data) {
  // metrics
  const metrics = document.getElementById('metrics-grid');
  const newCGPAHtml = data.newCGPA
    ? `<div class="metric"><div class="metric-label">Updated CGPA</div><div class="metric-val accent">${data.newCGPA}</div></div>`
    : '';
  metrics.innerHTML = `
    <div class="metric"><div class="metric-label">SGPA</div><div class="metric-val accent">${data.sgpa}</div></div>
    <div class="metric"><div class="metric-label">Total credits</div><div class="metric-val">${data.totalCredits}</div></div>
    <div class="metric"><div class="metric-label">Credit points</div><div class="metric-val">${data.totalCP}</div></div>
    ${newCGPAHtml}`;

  // table
  const tbody = document.getElementById('results-tbody');
  const parts = [];
  data.results.forEach(r => {
    const w = r.working;
    let wtext = '';
    if (w.type === 'absolute') {
      wtext = `Marks: ${w.marks}/100 → GP: ${w.finalGP}`;
    } else if (w.hasLab) {
      wtext = `WGP: (${w.s1GP}×.30)+(${w.s2GP}×.45)+(${w.leGP}×.25) = ${w.rawWGP} → ${w.wgp}\nT%: ${w.theoryPct}  Lab%: ${w.labPct}  Final%: ${w.finalPct} → GP: ${r.finalGP}`;
    } else {
      wtext = `(${w.s1GP}×.30)+(${w.s2GP}×.45)+(${w.leGP}×.25) = ${w.rawWGP} → ceil = ${w.wgp}`;
    }
    const passClass = r.finalGP > 0 ? 'grade-pass' : 'grade-fail';
    tbody.innerHTML += `<tr>
      <td>${r.name}</td>
      <td>${r.credits}</td>
      <td>${r.finalGP}</td>
      <td><span class="grade-badge ${passClass}">${r.grade}</span></td>
      <td><div class="working-text">${wtext}</div></td>
    </tr>`;
  });
  tbody.innerHTML += `<tr><td>Total</td><td>${data.totalCredits}</td><td>—</td><td>—</td><td></td></tr>`;

  // formula
  const formulaParts = data.results.map(r => `(${r.credits}×${r.finalGP})`).join(' + ');
  document.getElementById('formula-box').textContent =
    `SGPA = ${formulaParts} ÷ ${data.totalCredits} = ${data.totalCP} ÷ ${data.totalCredits} = ${data.sgpa}`;

  if (data.errors && data.errors.length) {
    showError('confirm-error', 'Warnings: ' + data.errors.join(', '));
  }
}

// ── nav ─────────────────────────────────────────────
function goBack() {
  document.getElementById('section-confirm').classList.add('hidden');
  document.getElementById('section-upload').classList.remove('hidden');
}
function startOver() {
  document.getElementById('section-results').classList.add('hidden');
  document.getElementById('section-upload').classList.remove('hidden');
  resetUpload();
  extractedSubjects = [];
  document.getElementById('subjects-list').innerHTML = '';
  document.getElementById('results-tbody').innerHTML = '';
  document.getElementById('metrics-grid').innerHTML = '';
  document.getElementById('formula-box').textContent = '';
  document.getElementById('current-cgpa').value = '';
  document.getElementById('current-credits').value = '';
}

// ── helpers ─────────────────────────────────────────
function setLoading(btnId, labelId, text, loading, spinner = true) {
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  btn.disabled = loading;
  label.textContent = text;
  const existing = btn.querySelector('.spinner');
  if (existing) existing.remove();
  if (loading && spinner !== false) {
    const s = document.createElement('div'); s.className = 'spinner';
    btn.appendChild(s);
  }
}
function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.classList.remove('hidden');
}
function hideError(id) {
  document.getElementById(id).classList.add('hidden');
}
