// ai-debugger.js v2.0 — Diagnostic IA Complet (Bridge TV + Backend + Extension Integration)
'use strict';

const AIDebugger = (() => {
  const API = 'http://127.0.0.1:4000';
  let _logs = [];
  let _resultEl = null;

  // ── COLLECT COMPLETE SYSTEM STATE ─────────────────────────────────────
  async function collectFullState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
        const bgState = resp?.state || {};
        resolve({
          timestamp: new Date().toISOString(),
          background: {
            backendReady: bgState.backendReady,
            tvConnected: bgState.tvConnected,
            activeSymbol: bgState.activeSymbol,
            activeTimeframe: bgState.activeTimeframe,
            activePrice: bgState.activePrice,
            lastUpdate: bgState.lastUpdate,
            lastSnapshot: bgState.lastSnapshot ? {
              symbol: bgState.lastSnapshot.symbol,
              bid: bgState.lastSnapshot.bid,
              ask: bgState.lastSnapshot.ask,
              timestamp: bgState.lastSnapshot.timestamp
            } : null
          },
          popup: {
            url: window.location.href,
            title: document.title
          },
          extension: {
            extensionId: chrome.runtime.id
          }
        });
      });
    });
  }

  // ── CHECK ENDPOINTS ───────────────────────────────────────────────────
  async function checkEndpoints() {
    const endpoints = [
      '/health',
      '/tradingview/live',
      '/extension/data'
    ];

    const results = [];
    for (const ep of endpoints) {
      try {
        const resp = await fetch(API + ep, {
          signal: AbortSignal.timeout(2000)
        });
        results.push({
          endpoint: ep,
          status: resp.status,
          ok: resp.ok
        });
      } catch (err) {
        results.push({
          endpoint: ep,
          status: 0,
          ok: false,
          error: err.message
        });
      }
    }
    return results;
  }

  // ── BUILD DIAGNOSTIC PROMPT ───────────────────────────────────────────
  async function buildDiagnosticPrompt(fullState, endpoints) {
    const lines = [
      '═══════════════════════════════════════════════════════════',
      'DIAGNOSTIC EXTENSION TRADING AUTO - BRIDGE TV ARCHITECTURE',
      '═══════════════════════════════════════════════════════════',
      '',
      `Timestamp: ${fullState.timestamp}`,
      `Extension ID: ${fullState.extension.extensionId}`,
      '',
      '───────────────────────────────────────────────────────────',
      'ÉTAT BACKGROUND (Service Worker)',
      '───────────────────────────────────────────────────────────',
      `Backend connecté: ${fullState.background.backendReady ? '✅ YES' : '❌ NO'}`,
      `Bridge TV actif: ${fullState.background.tvConnected ? '✅ YES' : '❌ NO'}`,
      `Symbole actif: ${fullState.background.activeSymbol || '--'}`,
      `Timeframe: ${fullState.background.activeTimeframe || '--'}`,
      `Prix: ${fullState.background.activePrice || '--'}`,
      `Dernière synchro: ${fullState.background.lastUpdate || 'N/A'}`,
      '',
      '───────────────────────────────────────────────────────────',
      'ENDPOINTS BRIDGE TV (http://127.0.0.1:4000)',
      '───────────────────────────────────────────────────────────'
    ];

    endpoints.forEach(ep => {
      lines.push(`${ep.endpoint.padEnd(20)} → ${ep.ok ? `✅ HTTP ${ep.status}` : `❌ ${ep.error || 'HTTP ' + ep.status}`}`);
    });

    lines.push('');
    lines.push('───────────────────────────────────────────────────────────');
    lines.push('QUESTIONS À L\'IA');
    lines.push('───────────────────────────────────────────────────────────');
    lines.push('1️⃣  Quel est le problème principal?');
    lines.push('2️⃣  Quelle est la cause probable?');
    lines.push('3️⃣  Quel fichier est concerné?');
    lines.push('4️⃣  Quel branchement manque?');
    lines.push('5️⃣  Quelle est la correction précise?');
    lines.push('');
    lines.push('Répondre en JSON: { problem, cause, file, missing, fix, codeSnippet }');
    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  // ── SEND DIAGNOSTIC TO AI ─────────────────────────────────────────────
  async function sendDiagnosticToAI(prompt) {
    try {
      const resp = await fetch(API + '/system-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'ai-debugger',
          action: 'DIAGNOSTIC_REQUEST',
          timestamp: new Date().toISOString(),
          prompt: prompt
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!resp.ok) throw new Error('Server response: ' + resp.status);

      const data = await resp.json();
      return data.result || data.diagnosis || data;
    } catch (err) {
      return {
        error: err.message,
        fallback: 'Impossible de contacter le serveur. Vérifiez que server.js tourne sur le port 4000.'
      };
    }
  }

  // ── DISPLAY DIAGNOSTIC ────────────────────────────────────────────────
  function displayDiagnostic(result) {
    if (!_resultEl) return;

    let html = '<div class="ai-diagnostic">';

    if (result.error) {
      html += `<div class="ai-error-box">
        <strong>⚠️ Erreur:</strong> ${result.error}<br>
        ${result.fallback ? `<em>${result.fallback}</em>` : ''}
      </div>`;
    } else {
      let parsed = result;
      if (typeof result === 'string') {
        try {
          const jsonMatch = result.match(/```json\n?([\s\S]*?)\n?```/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[1]);
          } else {
            parsed = JSON.parse(result);
          }
        } catch (_) {
          parsed = { raw: result };
        }
      }

      if (parsed.problem) html += `<div class="diagnostic-section"><strong>❌ Problème:</strong><br>${parsed.problem}</div>`;
      if (parsed.cause)   html += `<div class="diagnostic-section"><strong>🔍 Cause Probable:</strong><br>${parsed.cause}</div>`;
      if (parsed.file)    html += `<div class="diagnostic-section"><strong>📄 Fichier Concerné:</strong><br><code>${parsed.file}</code></div>`;
      if (parsed.missing) html += `<div class="diagnostic-section"><strong>⚙️ Branchement Manquant:</strong><br>${parsed.missing}</div>`;
      if (parsed.fix)     html += `<div class="diagnostic-section fix"><strong>✅ Correction:</strong><br>${parsed.fix}</div>`;
      if (parsed.codeSnippet) html += `<div class="diagnostic-section code"><strong>💻 Code:</strong><br><pre>${parsed.codeSnippet}</pre></div>`;
      if (parsed.raw)     html += `<div class="diagnostic-section raw"><strong>Réponse IA:</strong><br><pre>${parsed.raw}</pre></div>`;
    }

    html += '</div>';
    _resultEl.innerHTML = html;
    _resultEl.style.display = 'block';
  }

  // ── MAIN: RUN DIAGNOSTIC ──────────────────────────────────────────────
  async function runDiagnostic(containerEl) {
    _resultEl = containerEl;
    if (!_resultEl) return;

    _resultEl.innerHTML = '<div style="padding:8px;text-align:center">🔍 Diagnostic en cours...</div>';
    _resultEl.style.display = 'block';

    try {
      const fullState = await collectFullState();
      const endpoints = await checkEndpoints();
      const prompt = await buildDiagnosticPrompt(fullState, endpoints);
      const aiResult = await sendDiagnosticToAI(prompt);
      displayDiagnostic(aiResult);
    } catch (err) {
      _resultEl.innerHTML = `<div class="ai-error-box">Erreur générale: ${err.message}</div>`;
      _resultEl.style.display = 'block';
    }
  }

  return {
    runDiagnostic,
    collectFullState,
    checkEndpoints,
    buildDiagnosticPrompt,
    sendDiagnosticToAI
  };
})();

window.AIDebugger = AIDebugger;
