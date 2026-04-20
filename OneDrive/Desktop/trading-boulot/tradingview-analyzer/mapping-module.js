// mapping-module.js — Gère recherche/sauvegarde correspondances symboles Bridge TV
// POST /mapping/resolve → suggestions scoring
// POST /mapping/save → persiste correspondance
// GET /mapping/list → charge historique
'use strict';

const MappingModule = {
  
  _apiBase: 'http://127.0.0.1:4000',
  _savedMappings: {},  // Cache local
  _lastQuery: null,
  _lastSuggestions: [],
  
  // ── INIT ────────────────────────────────────────────────────────────
  init: function() {
    console.log('[MAPPING] v1.0 init');
    this.loadSavedMappings();
  },
  
  // ── LOAD SAVED MAPPINGS ────────────────────────────────────────────
  loadSavedMappings: async function() {
    try {
      const resp = await fetch(`${this._apiBase}/mapping/list`);
      const data = await resp.json();
      
      if (data.ok && data.mappings) {
        data.mappings.forEach(m => {
          this._savedMappings[m.userInput] = m.tvSymbol;
        });
        console.log(`[MAPPING] Loaded ${data.count} mappings`);
      }
    } catch (err) {
      console.log('[MAPPING] Load error:', err.message);
    }
  },
  
  // ── RESOLVE SYMBOL (recherche intelligente Bridge TV) ──────────────
  resolveSymbol: async function(userInput, price = null, type = null) {
    if (!userInput) return { ok: false, error: 'Input required' };
    
    this._lastQuery = userInput;
    
    // 1. Vérifier si déjà mappé
    if (this._savedMappings[userInput.toUpperCase()]) {
      const mapped = this._savedMappings[userInput.toUpperCase()];
      console.log(`[MAPPING] ${userInput} → ${mapped} (from cache)`);
      return {
        ok: true,
        source: 'saved',
        matched: mapped,
        confidence: 100
      };
    }
    
    // 2. Envoyer au backend pour scoring
    try {
      const resp = await fetch(`${this._apiBase}/mapping/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userInput, price, type }),
        signal: AbortSignal.timeout(5000)
      });
      
      const data = await resp.json();
      
      if (!data.ok) {
        return { ok: false, error: data.error || 'Resolve failed' };
      }
      
      this._lastSuggestions = data.suggestions || [];
      
      return {
        ok: true,
        source: 'search',
        query: userInput,
        suggestions: this._lastSuggestions,
        topMatch: this._lastSuggestions[0] || null
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  
  // ── SAVE MAPPING (persiste correspondance) ─────────────────────────
  saveMapping: async function(userInput, tvSymbol) {
    if (!userInput || !tvSymbol) {
      return { ok: false, error: 'Input and symbol required' };
    }
    
    try {
      const resp = await fetch(`${this._apiBase}/mapping/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput: userInput.toUpperCase(), tvSymbol }),
        signal: AbortSignal.timeout(5000)
      });
      
      const data = await resp.json();
      
      if (data.ok) {
        // Update local cache
        this._savedMappings[userInput.toUpperCase()] = tvSymbol;
        console.log(`[MAPPING] Saved: ${userInput} → ${tvSymbol}`);
      }
      
      return data;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  
  // ── GET SAVED MAPPINGS ──────────────────────────────────────────────
  getSavedMappings: function() {
    const list = [];
    for (const [user, symbol] of Object.entries(this._savedMappings)) {
      list.push({ userInput: user, tvSymbol: symbol });
    }
    return list;
  },
  
  // ── GET LAST SUGGESTIONS ───────────────────────────────────────────
  getLastSuggestions: function() {
    return this._lastSuggestions;
  },
  
  // ── RESET ───────────────────────────────────────────────────────────
  reset: function() {
    this._lastQuery = null;
    this._lastSuggestions = [];
  }
};
