// 設定頁面的 JavaScript
// 檢查是否在 Electron 環境中
let ipcRenderer;
if (typeof require !== 'undefined') {
  ({ ipcRenderer } = require('electron'));
} else if (window.electronAPI) {
  // 使用 preload 提供的 API
  ipcRenderer = {
    invoke: (channel, ...args) => {
      if (channel === 'get-settings') {
        return window.electronAPI.settings.get();
      } else if (channel === 'save-settings') {
        return window.electronAPI.settings.save(args[0]);
      } else if (channel === 'update-shortcuts') {
        return window.electronAPI.settings.updateShortcuts(args[0]);
      }
    }
  };
}

// 設定管理類
class SettingsManager {
  constructor() {
    this.settings = {};
    this.originalSettings = {};
    this.recordingShortcut = null;
    this.shortcuts = {
      region: { default: 'Ctrl+R', current: 'Ctrl+R' },
      fullscreen: { default: 'PrintScreen', current: 'PrintScreen' },
      window: { default: 'Alt+W', current: 'Alt+W' }
    };
    
    this.init();
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    this.updateUI();
  }

  async loadSettings() {
    try {
      // 從主程序獲取設定
      this.settings = await ipcRenderer.invoke('get-settings') || {};
      this.originalSettings = JSON.parse(JSON.stringify(this.settings));

      // 兼容舊版鍵名並正規化為 A 格式：
      // A: shortcuts = { enabled, region:{key,enabled}, fullscreen:{...}, window:{...} }
      // B: { shortcuts:{enabled?:bool}, regionCapture, fullScreenCapture, activeWindowCapture }
      const normalized = { enabled: true, region: undefined, fullscreen: undefined, window: undefined };

      // 1) 先處理 A 格式
      if (this.settings.shortcuts && (this.settings.shortcuts.region || this.settings.shortcuts.fullscreen || this.settings.shortcuts.window)) {
        const s = this.settings.shortcuts;
        normalized.enabled = s.enabled !== false;
        ['region','fullscreen','window'].forEach(t => {
          if (s[t]) {
            const key = typeof s[t].key === 'string' && s[t].key.trim() ? s[t].key.trim() : this.shortcuts[t]?.default;
            const enabled = s[t].enabled !== false;
            normalized[t] = { key, enabled };
          }
        });
      } else {
        // 2) 若無 A 格式，嘗試從 B 格式映射
        const mapBtoA = {
          region: this.settings.regionCapture,
          fullscreen: this.settings.fullScreenCapture,
          window: this.settings.activeWindowCapture
        };
        normalized.enabled = this.settings?.shortcuts?.enabled !== false; // 若有舊 shortcuts.enabled 亦沿用
        ['region','fullscreen','window'].forEach(t => {
          const keyStr = mapBtoA[t];
          const key = (typeof keyStr === 'string' && keyStr.trim()) ? keyStr.trim() : this.shortcuts[t]?.default;
          normalized[t] = { key, enabled: true };
        });
      }

      // 填補任何缺少的欄位為預設
      ['region','fullscreen','window'].forEach(t => {
        if (!normalized[t]) {
          normalized[t] = { key: this.shortcuts[t]?.default, enabled: true };
        } else if (!normalized[t].key) {
          normalized[t].key = this.shortcuts[t]?.default;
        }
      });

      // 寫回到 this.settings，之後保存會讓主程式持久化新格式
      this.settings.shortcuts = normalized;

      // 將目前快捷鍵載入至本地狀態（供 UI 顯示）
      Object.entries(this.shortcuts).forEach(([type, obj]) => {
        const k = this.settings.shortcuts?.[type]?.key || obj.default;
        this.shortcuts[type].current = k;
      });

    } catch (error) {
      console.error('載入設定失敗:', error);
      this.settings = this.getDefaultSettings();
    }
  }

  getDefaultSettings() {
    return {
      window: {
        startupAlwaysOnTop: false,
        minimizeToTray: false
      },
      shortcuts: {
        enabled: true,
        region: { enabled: true, key: 'Ctrl+R' },
        fullscreen: { enabled: true, key: 'PrintScreen' },
        window: { enabled: true, key: 'Alt+W' }
      },
      general: {
        autoSave: false,
        screenshotFormat: 'png'
      }
    };
  }

  // 保留空方法，避免影響既有外觀
  applyTheme() {}

  bindEvents() {
    // 視窗設定
    document.getElementById('startup-always-on-top').addEventListener('change', (e) => {
      this.settings.alwaysOnTop = e.target.checked;
    });

    document.getElementById('minimize-to-tray').addEventListener('change', (e) => {
      this.settings.window = this.settings.window || {};
      this.settings.window.minimizeToTray = e.target.checked;
    });

    // 快捷鍵設定
    document.getElementById('enable-global-shortcuts').addEventListener('change', (e) => {
      this.settings.shortcuts = this.settings.shortcuts || {};
      this.settings.shortcuts.enabled = e.target.checked;
      this.toggleShortcutsList(e.target.checked);
    });

    // 各個快捷鍵的啟用/停用
    ['region', 'fullscreen', 'window'].forEach(type => {
      const checkbox = document.getElementById(`shortcut-${type}-enabled`);
      checkbox.addEventListener('change', (e) => {
        this.settings.shortcuts = this.settings.shortcuts || {};
        this.settings.shortcuts[type] = this.settings.shortcuts[type] || {};
        this.settings.shortcuts[type].enabled = e.target.checked;
      });
    });

    // 編輯快捷鍵按鈕
    document.querySelectorAll('.edit-key-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const shortcutType = e.target.dataset.shortcut;
        this.startRecordingShortcut(shortcutType);
      });
    });

    // 重設快捷鍵按鈕
    document.querySelectorAll('.reset-key-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const shortcutType = e.target.dataset.shortcut;
        this.resetShortcut(shortcutType);
      });
    });

    // 一般設定
    document.getElementById('auto-save').addEventListener('change', (e) => {
      this.settings.autoSave = e.target.checked;
    });

    document.getElementById('screenshot-format').addEventListener('change', (e) => {
      this.settings.screenshotFormat = e.target.value;
    });

    // 按鈕事件
    document.getElementById('save-settings').addEventListener('click', () => {
      this.saveSettings();
    });

    document.getElementById('cancel-settings').addEventListener('click', () => {
      window.close();
    });

    // ESC 鍵取消錄製
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.recordingShortcut) {
        this.cancelRecording();
      }
    });
  }

  updateUI() {
    // 更新視窗設定
    document.getElementById('startup-always-on-top').checked =
      this.settings.alwaysOnTop || false;
    if (this.settings.window) {
      document.getElementById('minimize-to-tray').checked =
        this.settings.window.minimizeToTray || false;
    }

    // 更新快捷鍵設定
    if (this.settings.shortcuts) {
      document.getElementById('enable-global-shortcuts').checked = 
        this.settings.shortcuts.enabled !== false;
      
      ['region', 'fullscreen', 'window'].forEach(type => {
        const shortcut = this.settings.shortcuts[type];
        if (shortcut) {
          document.getElementById(`shortcut-${type}-enabled`).checked =
            shortcut.enabled !== false;
          document.getElementById(`shortcut-${type}-key`).value =
            this.displayAccelerator(shortcut.key || this.shortcuts[type].default);
        }
      });

      this.toggleShortcutsList(this.settings.shortcuts.enabled !== false);
    }

    // 更新一般設定
    document.getElementById('auto-save').checked =
      this.settings.autoSave || false;
    document.getElementById('screenshot-format').value =
      this.settings.screenshotFormat || 'png';
  }

  toggleShortcutsList(enabled) {
    const shortcutsList = document.getElementById('shortcuts-list');
    shortcutsList.style.opacity = enabled ? '1' : '0.5';
    shortcutsList.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  startRecordingShortcut(type) {
    if (this.recordingShortcut) {
      this.cancelRecording();
    }

    this.recordingShortcut = type;
    const input = document.getElementById(`shortcut-${type}-key`);
    input.classList.add('recording');
    input.value = '請按下組合鍵...';
    
    // 監聽按鍵
    const keyHandler = (e) => {
      e.preventDefault();
      
      if (e.key === 'Escape') {
        this.cancelRecording();
        return;
      }

      const modifiers = [];
      // 根據系統使用正確的修飾鍵名稱（統一顯示為 Ctrl/Alt/Shift/Super/Command）
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      
      if (e.ctrlKey) modifiers.push('Ctrl');
      if (e.altKey) modifiers.push('Alt');
      if (e.shiftKey) modifiers.push('Shift');
      if (isMac && e.metaKey) modifiers.push('Command');   // macOS ⌘
      if (!isMac && e.metaKey) modifiers.push('Super');    // Windows 鍵/Meta

      // 獲取實際按鍵
      let key = e.key;
      
      // 處理特殊字元和按鍵
      if (key === ' ') key = 'Space';
      else if (key === '`') key = 'Backquote';  // 反引號鍵
      else if (key === '~') key = 'Backquote';  // 波浪號（Shift + `）
      else if (key === 'Tab') key = 'Tab';
      else if (key === 'Enter') key = 'Return';
      else if (key === 'Backspace') key = 'Backspace';
      else if (key === 'Delete') key = 'Delete';
      else if (key === 'Escape') key = 'Escape';
      else if (key === 'CapsLock') key = 'CapsLock';
      else if (key === 'NumLock') key = 'NumLock';
      else if (key === 'ScrollLock') key = 'ScrollLock';
      else if (key === 'Pause') key = 'Pause';
      else if (key === 'Insert') key = 'Insert';
      else if (key === 'Home') key = 'Home';
      else if (key === 'End') key = 'End';
      else if (key === 'PageUp') key = 'PageUp';
      else if (key === 'PageDown') key = 'PageDown';
      else if (key === 'ArrowUp') key = 'Up';
      else if (key === 'ArrowDown') key = 'Down';
      else if (key === 'ArrowLeft') key = 'Left';
      else if (key === 'ArrowRight') key = 'Right';
      else if (key === 'PrintScreen') key = 'PrintScreen';
      else if (key.startsWith('F') && key.length <= 3) key = key; // F1-F12
      else if (key === '-') key = 'Minus';
      else if (key === '=') key = 'Equal';
      else if (key === '[') key = 'BracketLeft';
      else if (key === ']') key = 'BracketRight';
      else if (key === ';') key = 'Semicolon';
      else if (key === "'") key = 'Quote';
      else if (key === '\\') key = 'Backslash';
      else if (key === ',') key = 'Comma';
      else if (key === '.') key = 'Period';
      else if (key === '/') key = 'Slash';
      else if (key.length === 1) {
        // 單一字元，轉為大寫
        key = key.toUpperCase();
      }

      // 若目前按下的是修飾鍵（尚未有主鍵），先不要結束錄製，等待主鍵
      const isModifierKeyName = ['Ctrl','Shift','Alt','Meta','Super','Command','CommandOrControl','Control'].includes(key);
      if (isModifierKeyName) {
        // 顯示目前已按下的修飾鍵，提示還需再按主鍵
        input.value = (modifiers.length ? modifiers.join('+') + ' + …' : '請按下組合鍵...');
        return;
      }

      // 組合快捷鍵字串（修飾鍵 + 主鍵）
      const shortcut = [...modifiers, key].join('+');
      
      // 允許的單鍵或組合鍵（仍保留提示規則）
      const allowedSingleKeys = [
        'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
        'PrintScreen','Insert','Delete','Home','End','PageUp','PageDown',
        'Tab','Backquote','Escape','Pause','ScrollLock','NumLock'
      ];
      
      // 需要至少一個修飾鍵的按鍵
      const requiresModifier = !allowedSingleKeys.includes(key);
      
      if (!requiresModifier || modifiers.length > 0) {
        // 有修飾鍵或是允許的單鍵
        this.setShortcut(type, shortcut);
        document.removeEventListener('keydown', keyHandler);
      }
    };

    document.addEventListener('keydown', keyHandler);
  }

  cancelRecording() {
    if (!this.recordingShortcut) return;

    const input = document.getElementById(`shortcut-${this.recordingShortcut}-key`);
    input.classList.remove('recording');
    input.value = this.shortcuts[this.recordingShortcut].current;
    this.recordingShortcut = null;
  }

  setShortcut(type, shortcut) {
    // 檢查快捷鍵衝突
    for (const [otherType, data] of Object.entries(this.shortcuts)) {
      if (otherType !== type && data.current === shortcut) {
        alert(`快捷鍵 ${shortcut} 已被「${this.getShortcutName(otherType)}」使用`);
        this.cancelRecording();
        return;
      }
    }

    // Windows 可能不支援 PrintScreen 搭配修飾鍵
    const isWindows = navigator.userAgent.includes("Windows");
    if (isWindows && shortcut.includes("PrintScreen") && shortcut.includes("+")) {
      alert(`警告：Windows 可能不支援「${shortcut}」。若無法生效，請改用其他主鍵或只使用 PrintScreen 單鍵。`);
    }

    // 只含 Shift + 字母 的組合在部分系統上無法可靠註冊（易被輸入法/前景應用攔截）
    const onlyShiftLetter = /^Shift\+[A-Z]$/.test(shortcut);
    if (onlyShiftLetter) {
      alert(`提示：僅 Shift + 字母（如「${shortcut}」）在 Windows 上常無法作為全域快捷鍵。\n請改用 Ctrl/Alt/Super 搭配的組合，如：Ctrl+Alt+R 或 Ctrl+Shift+R。`);
      this.cancelRecording();
      return;
    }

    // 正規化為 Electron Accelerator 格式（Ctrl/Alt/Shift/Super 順序）
    const normalized = this.normalizeAccelerator(shortcut);

    this.shortcuts[type].current = normalized;
    this.settings.shortcuts = this.settings.shortcuts || {};
    this.settings.shortcuts[type] = this.settings.shortcuts[type] || {};
    this.settings.shortcuts[type].key = normalized;

    const input = document.getElementById(`shortcut-${type}-key`);
    input.classList.remove('recording');
    input.value = this.displayAccelerator(normalized);
    this.recordingShortcut = null;
  }

  resetShortcut(type) {
    const defaultKey = this.shortcuts[type].default;
    this.shortcuts[type].current = defaultKey;
    this.settings.shortcuts[type] = this.settings.shortcuts[type] || {};
    this.settings.shortcuts[type].key = defaultKey;
    document.getElementById(`shortcut-${type}-key`).value = defaultKey;
  }

  getShortcutName(type) {
    const names = {
      region: '區域截圖',
      fullscreen: '全螢幕截圖',
      window: '視窗截圖'
    };
    return names[type] || type;
  }

  // 顯示給使用者看的快捷鍵字樣（Windows 顯示 Ctrl 而非 CommandOrControl）
  displayAccelerator(acc) {
    if (!acc || typeof acc !== 'string') return acc;
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    let a = acc;
    if (!isMac) {
      a = a.replace(/\bCommandOrControl\b/g, 'Ctrl')
           .replace(/\bCommand\b/g, 'Ctrl');
    } else {
      a = a.replace(/\bCommandOrControl\b/g, 'Command');
    }
    return a;
  }

  // 將使用者錄到的鍵位字串轉成 Electron Accelerator
  normalizeAccelerator(acc) {
    if (!acc || typeof acc !== 'string') return acc;

    // 標準化修飾鍵名稱
    let a = acc
      .replace(/\bControl\b/g, 'Ctrl')
      .replace(/\bCommandOrControl\b/g, 'CommandOrControl') // 保留
      .replace(/\bCommand\b/g, 'Command')
      .replace(/\bOption\b/g, 'Alt')
      .replace(/\bReturn\b/g, 'Enter');

    // 拆解並排序修飾鍵
    const parts = a.split('+').filter(Boolean);
    const mods = new Set(['CommandOrControl','Command','Ctrl','Alt','Shift','Super']);
    const picked = new Set();
    const ordered = [];

    const order = ['CommandOrControl','Command','Ctrl','Alt','Shift','Super'];
    for (const want of order) {
      if (parts.some(p => p === want)) {
        ordered.push(want);
        picked.add(want);
      }
    }
    // 剩餘的就是按鍵本體（取最後一個非修飾）
    const keys = parts.filter(p => !mods.has(p));
    const key = keys.length ? keys[keys.length - 1] : '';

    return [...ordered, key].filter(Boolean).join('+');
  }

  async saveSettings() {
    try {
      // 儲存設定到主程序（主程式會自動立即套用快捷鍵）
      await ipcRenderer.invoke('save-settings', this.settings);

      // 再呼叫一次 update-shortcuts，確保覆蓋任何競態
      let result = { success: true, failures: [], warnings: [] };
      if (this.settings.shortcuts) {
        const normalizedShortcuts = JSON.parse(JSON.stringify(this.settings.shortcuts));
        ['region','fullscreen','window'].forEach(t => {
          if (normalizedShortcuts[t]) {
            const k = normalizedShortcuts[t].key;
            if (typeof k === 'string') {
              normalizedShortcuts[t].key = this.normalizeAccelerator(k);
            }
          }
        });
        result = await ipcRenderer.invoke('update-shortcuts', normalizedShortcuts);
      }

      // 顯示警告（例如 Windows 上 PrintScreen+修飾鍵）
      if (result.warnings && result.warnings.length > 0) {
        const msg = result.warnings
          .map(w => `• ${this.getShortcutName(w.type)}：${w.key}（${w.reason}）`)
          .join('\n');
        alert(`注意：\n${msg}`);
      }

      // 顯示註冊失敗原因
      if (result.failures && result.failures.length > 0) {
        const msg = result.failures
          .map(f => `• ${this.getShortcutName(f.type)}：${f.key}（${f.reason}）`)
          .join('\n');
        alert(`以下快捷鍵未能啟用：\n${msg}\n\n請嘗試更換為其他組合（建議避免與系統衝突的按鍵）。`);
        // 不關閉視窗，讓使用者可立即修改
        return;
      }

      // 回讀目前已註冊狀態，顯示給使用者（若為 0，立即重試一次註冊後再回讀）
      try {
        let reg = await ipcRenderer.invoke('get-registered-shortcuts');
        if (reg && (reg.count === 0 || reg.globalEnabled === false)) {
          // 嘗試再註冊一次（避免偶發未掛上 globalShortcut）
          if (this.settings?.shortcuts) {
            const normalizedShortcuts = JSON.parse(JSON.stringify(this.settings.shortcuts));
            ['region','fullscreen','window'].forEach(t => {
              if (normalizedShortcuts[t]) {
                const k = normalizedShortcuts[t].key;
                if (typeof k === 'string') {
                  normalizedShortcuts[t].key = this.normalizeAccelerator(k);
                }
              }
            });
            try {
              await ipcRenderer.invoke('update-shortcuts', normalizedShortcuts);
              // 稍等掛載完成
              await new Promise(r => setTimeout(r, 300));
              reg = await ipcRenderer.invoke('get-registered-shortcuts');
            } catch {}
          }
        }

        const lines = [
          `全域快捷鍵：${reg.globalEnabled ? '啟用' : '停用'}`,
          `已註冊：${reg.count} 項`,
          `區域=${this.displayAccelerator(reg.registered?.region || '(未註冊)')}`,
          `全螢幕=${this.displayAccelerator(reg.registered?.fullscreen || '(未註冊)')}`,
          `視窗=${this.displayAccelerator(reg.registered?.window || '(未註冊)')}`
        ];
        alert(lines.join('\n'));
      } catch {}

      // 全部成功再關閉視窗
      window.close();
    } catch (error) {
      console.error('儲存設定失敗:', error);
      alert('儲存設定失敗，請重試');
    }
  }
}

// 初始化設定管理器
document.addEventListener('DOMContentLoaded', () => {
  new SettingsManager();
});