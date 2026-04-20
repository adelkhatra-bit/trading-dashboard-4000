'use strict';

// ─── LIA ROBOT — Moteur d'analyse PRO multi-TF ────────────────────────────────
// Priorité: Pine Script > RSI extension > rien

function rsiToLecture(rsi) {
  if (rsi == null || isNaN(rsi)) return null;
  if (rsi >= 70) return 'SURACHETÉ';
  if (rsi >= 58) return 'HAUSSIER';
  if (rsi >= 42) return 'NEUTRE';
  if (rsi >= 30) return 'BAISSIER';
  return 'SURVENDU';
}

function lectureToDirection(lecture) {
  if (!lecture) return null;
  const u = String(lecture).toUpperCase();
  if (u.includes('HAUSSIER') || u === 'SURACHETÉ' || u.includes('ACHAT') || u === 'HAUSSE') return 'LONG';
  if (u.includes('BAISSIER') || u === 'SURVENDU'  || u.includes('VENTE')  || u === 'BAISSE') return 'SHORT';
  return 'NEUTRE';
}

const SL_TP_DEFAULTS = {
  XAUUSD: { sl: 12, tp: 26, unit: '$' },
  GOLD:   { sl: 12, tp: 26, unit: '$' },
  BTCUSD: { sl: 280, tp: 580, unit: '$' },
  EURUSD: { sl: 0.0018, tp: 0.0038, unit: 'pip' },
  DEFAULT:{ sl: 15, tp: 32, unit: 'pts' }
};

function autoSLTP(symbol, price, direction) {
  const cfg = SL_TP_DEFAULTS[symbol] || SL_TP_DEFAULTS.DEFAULT;
  if (direction === 'LONG')  return { sl: +(price - cfg.sl).toFixed(2), tp: +(price + cfg.tp).toFixed(2), rr: (cfg.tp / cfg.sl).toFixed(1) };
  if (direction === 'SHORT') return { sl: +(price + cfg.sl).toFixed(2), tp: +(price - cfg.tp).toFixed(2), rr: (cfg.tp / cfg.sl).toFixed(1) };
  return { sl: null, tp: null, rr: null };
}

function analyzeTFs(rv) {
  const raw = [
    { tf: 'M1',  rsi: rv.rsi_1m,  lecture: rv.lecture_1m  || rv.lectureTech1, weight: 1 },
    { tf: 'M5',  rsi: rv.rsi_5m,  lecture: rv.lecture_5m  || rv.lectureTech2, weight: 2 },
    { tf: 'M15', rsi: rv.rsi_15m, lecture: rv.lecture_15m || rv.lectureTech3, weight: 3 },
    { tf: 'H1',  rsi: rv.rsi_60m, lecture: rv.lecture_60m || rv.lectureTech4, weight: 4 },
  ];

  const tfs = raw.map(t => {
    const lecture = t.lecture || rsiToLecture(t.rsi);
    const direction = lectureToDirection(lecture);
    return { ...t, lecture, direction, hasPine: !!t.lecture, hasRsi: t.rsi != null };
  });

  const known = tfs.filter(t => t.direction !== null);
  const longs  = known.filter(t => t.direction === 'LONG');
  const shorts  = known.filter(t => t.direction === 'SHORT');
  const total   = known.reduce((s, t) => s + t.weight, 0);
  const longW   = longs.reduce((s, t)  => s + t.weight, 0);
  const shortW  = shorts.reduce((s, t) => s + t.weight, 0);

  const longScore  = total > 0 ? Math.round(longW  / total * 100) : 0;
  const shortScore = total > 0 ? Math.round(shortW / total * 100) : 0;
  const tfCount = known.length;

  const pineScore = rv.long_score != null ? { long: rv.long_score, short: rv.short_score } : null;

  let verdict = 'WAIT';
  if (rv.verdict) {
    verdict = rv.verdict;
  } else if (tfCount >= 2) {
    if (longScore  >= 65) verdict = 'LONG';
    else if (shortScore >= 65) verdict = 'SHORT';
  }

  const pineCount = tfs.filter(t => t.hasPine).length;
  const rsiCount  = tfs.filter(t => t.hasRsi && !t.hasPine).length;
  const source = pineCount >= 3 ? 'pine' : rsiCount >= 2 ? 'rsi' : 'insuffisant';

  return { tfs, longScore, shortScore, verdict, tfCount, pineScore, source, pineCount, rsiCount };
}

// ── Ligne détaillée par TF ────────────────────────────────────────────────────
function tfLine(t) {
  const icon = t.direction === 'LONG' ? '🟢' : t.direction === 'SHORT' ? '🔴' : t.direction === 'NEUTRE' ? '⚪' : '⬜';
  const rsiStr = t.rsi != null ? ` RSI:${Number(t.rsi).toFixed(0)}` : ' RSI:--';
  const lec = t.lecture || '—';
  const pine = t.hasPine ? '' : ' *(ext)*';
  return `${icon} ${t.tf.padEnd(4)}${rsiStr.padEnd(8)} ${lec}${pine}`;
}

// ── Déduction structure depuis alignement TF ─────────────────────────────────
function inferStructure(tfs, verdict, rv) {
  const lines = [];

  // Zone
  if (rv.in_top_zone || rv.inTop) lines.push('📍 Zone: RÉSISTANCE (top) — biais SHORT structurel');
  else if (rv.in_bot_zone || rv.inBot) lines.push('📍 Zone: SUPPORT (bot) — biais LONG structurel');
  else lines.push('📍 Zone: milieu range — prudence, pas de biais fort');

  // Structure inter-TF
  const h1Dir = tfs.find(t => t.tf === 'H1')?.direction;
  const m15Dir = tfs.find(t => t.tf === 'M15')?.direction;
  const m5Dir  = tfs.find(t => t.tf === 'M5')?.direction;
  const m1Dir  = tfs.find(t => t.tf === 'M1')?.direction;

  if (h1Dir && m15Dir && h1Dir === m15Dir) {
    lines.push(`📐 Structure: H1+M15 alignés ${h1Dir} — structure solide`);
  } else if (h1Dir && m15Dir && h1Dir !== m15Dir) {
    lines.push(`⚠️ Structure: H1=${h1Dir} ≠ M15=${m15Dir} — conflit TF, attendre`);
  }

  if (m5Dir && m1Dir && m5Dir === m1Dir && m5Dir === verdict) {
    lines.push(`⚡ Timing: M5+M1 alignés ${m5Dir} — momentum court terme confirmé`);
  } else if (m1Dir) {
    lines.push(`🔎 Timing M1: ${m1Dir} — confirmation entrée requise`);
  }

  // Rejet
  if (rv.bearRej) lines.push(`🔻 Rejet baissier détecté (bearRej: ${rv.bearRej})`);
  if (rv.bullRej) lines.push(`🔺 Rejet haussier détecté (bullRej: ${rv.bullRej})`);

  // Liquidité
  if (rv.liq_haute_active) lines.push('💧 Liquidité haute active — sweep possible au-dessus');
  if (rv.liq_basse_active) lines.push('💧 Liquidité basse active — sweep possible en dessous');

  return lines;
}

// ── Texte PRO complet ─────────────────────────────────────────────────────────
function generateRobotText(symbol, price, alignment, phase, tradeCtx) {
  const { tfs, longScore, shortScore, verdict, tfCount, pineScore, source } = alignment;
  const rv = tradeCtx?._rv || {};

  const priceStr = price != null ? price.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '?';
  const tfLines  = tfs.map(tfLine).join('\n');
  const scoreStr = pineScore
    ? `Score Pine: LONG ${pineScore.long}% · SHORT ${pineScore.short}%`
    : `Alignement RSI: LONG ${longScore}% · SHORT ${shortScore}%`;
  const srcTag = source === 'pine' ? '📡 Pine Script actif' : source === 'rsi' ? '📊 RSI extension (Pine inactif)' : '⚠️ Données insuffisantes — activer Pine Robot V12';

  const inPosition = tradeCtx?.entered || phase === 'OPEN' || phase === 'MANAGE';
  const isEntering = phase === 'ENTRER' || phase === 'ENTERING';
  const isArmed    = phase === 'ANALYSER' || phase === 'ARMED' || (!inPosition && !isEntering && tfCount > 0 && verdict !== 'WAIT');

  // ── PAS DE DONNÉES ────────────────────────────────────────────────────────
  if (tfCount === 0 && !inPosition) {
    return [
      `⏳ ${symbol} @ ${priceStr} — EN ATTENTE DE DONNÉES`,
      '',
      'Aucun signal RSI multi-TF disponible.',
      'Action: activer RSI sur TradingView ou lancer ANALYSER.',
      '',
      srcTag
    ].join('\n');
  }

  // ── ANALYSER / ARMÉ ───────────────────────────────────────────────────────
  if (isArmed || (!inPosition && !isEntering)) {
    const structLines = inferStructure(tfs, verdict, tradeCtx?._rv || {});
    const anticipation = tradeCtx?.anticipation;
    const verdictIcon = verdict === 'LONG' ? '🟢' : verdict === 'SHORT' ? '🔴' : '⚪';

    const header = verdict === 'LONG'
      ? `🔍 ${symbol} @ ${priceStr} — SETUP LONG`
      : verdict === 'SHORT'
        ? `🔍 ${symbol} @ ${priceStr} — SETUP SHORT`
        : `🔍 ${symbol} @ ${priceStr} — Surveillance`;

    const sltp = (verdict === 'LONG' || verdict === 'SHORT') ? autoSLTP(symbol, price, verdict) : null;
    const niveaux = tradeCtx?.sl
      ? `📍 Niveaux bridge: SL ${tradeCtx.sl} · TP ${tradeCtx.tp} · R:R ${tradeCtx.rr || '?'}`
      : sltp
        ? `📍 Niveaux auto: SL ${sltp.sl} · TP ${sltp.tp} · R:R 1:${sltp.rr}`
        : null;

    const waitLine = verdict === 'LONG'
      ? `⏳ Attendre: confirmation M1 + proximité zone support`
      : verdict === 'SHORT'
        ? `⏳ Attendre: rejet résistance + M1 baissier`
        : `⏳ Pas d'alignement — attendre direction franche M15+H1`;

    return [
      header,
      '',
      '── Analyse multi-TF ──',
      tfLines,
      '',
      scoreStr,
      '',
      '── Structure & contexte ──',
      ...structLines,
      anticipation ? `🎯 Anticipation Pine: ${anticipation}` : null,
      '',
      niveaux,
      waitLine,
      '',
      srcTag
    ].filter(l => l != null).join('\n');
  }

  // ── ENTRÉE EN COURS ───────────────────────────────────────────────────────
  if (isEntering) {
    const dir  = tradeCtx?.direction || verdict;
    const sltp = tradeCtx?.sl
      ? { sl: tradeCtx.sl, tp: tradeCtx.tp, rr: tradeCtx.rr || '?' }
      : autoSLTP(symbol, price, dir);
    return [
      `✅ ENTRÉE ${dir} — ${symbol} @ ${priceStr}`,
      '',
      tfLines,
      '',
      scoreStr,
      '',
      `🔴 SL: ${sltp.sl}  🟢 TP: ${sltp.tp}  R:R 1:${sltp.rr}`,
      '',
      'Structure verrouillée. Ne pas toucher au SL tant que la zone tient.',
      srcTag
    ].join('\n');
  }

  // ── EN POSITION ───────────────────────────────────────────────────────────
  if (inPosition) {
    const dir = tradeCtx?.direction || verdict;
    const sl  = tradeCtx?.sl  || '—';
    const tp  = tradeCtx?.tp  || '—';
    const pnl = tradeCtx?.pnl != null ? `${tradeCtx.pnl > 0 ? '+' : ''}${tradeCtx.pnl.toFixed(0)} pts` : '—';
    const structLines = inferStructure(tfs, verdict, tradeCtx?._rv || {});
    return [
      `📌 EN POSITION ${dir} — ${symbol} @ ${priceStr}`,
      '',
      tfLines,
      '',
      scoreStr,
      '',
      '── Structure live ──',
      ...structLines,
      '',
      `🔴 SL: ${sl}  🟢 TP: ${tp}  P&L: ${pnl}`,
      '',
      'Je surveille. Pas d\'action tant que la structure tient.',
      srcTag
    ].join('\n');
  }

  return `📊 ${symbol} @ ${priceStr}\n${tfLines}\n${scoreStr}\n${srcTag}`;
}

// ── Export principal ──────────────────────────────────────────────────────────
function analyze({ symbol, price, robotV12, phase, tradeCtx }) {
  const rv = robotV12 || {};
  const alignment = analyzeTFs(rv);
  // Passer rv dans tradeCtx._rv pour que generateRobotText accède aux zones/rejet
  const enrichedCtx = Object.assign({}, tradeCtx, { _rv: rv });
  const text = generateRobotText(symbol, price, alignment, phase, enrichedCtx);
  const sltp = !tradeCtx?.sl && alignment.verdict !== 'WAIT'
    ? autoSLTP(symbol, price, alignment.verdict)
    : (tradeCtx || {});

  return {
    symbol,
    price,
    verdict: alignment.verdict,
    longScore: alignment.longScore,
    shortScore: alignment.shortScore,
    tfs: alignment.tfs,
    source: alignment.source,
    tfCount: alignment.tfCount,
    sl: sltp.sl || tradeCtx?.sl || null,
    tp: sltp.tp || tradeCtx?.tp || null,
    rr: sltp.rr || tradeCtx?.rr || null,
    text,
    phase
  };
}

module.exports = { analyze, analyzeTFs, rsiToLecture, autoSLTP, generateRobotText };
