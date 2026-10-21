import { db } from '../db/db';

export type ThemeMode = 'light' | 'dark';
export type FontSizeOption = 'small' | 'medium' | 'large';

export interface AppSettings {
  theme: ThemeMode;
  fontSize: FontSizeOption;
  defaultPaperTitle: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  fontSize: 'medium',
  defaultPaperTitle: 'পদার্থবিজ্ঞান ১ম পত্র - মডেল টেস্ট',
};

const SETTINGS_KEY = 'settings';

/**
 * Apply settings to the DOM (Tailwind .dark class and root html font size)
 */
export function applySettingsToDOM(settings: AppSettings): void {
  // 1. Theme
  if (settings.theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }

  // 2. Root Font Size
  if (settings.fontSize === 'small') {
    document.documentElement.style.fontSize = '14px';
  } else if (settings.fontSize === 'large') {
    document.documentElement.style.fontSize = '18px';
  } else {
    document.documentElement.style.fontSize = '16px';
  }
}

/**
 * Get current settings from meta table with fallback
 */
export async function getAppSettings(): Promise<AppSettings> {
  try {
    const record = await db.meta.get(SETTINGS_KEY);
    if (record && record.value) {
      return {
        ...DEFAULT_SETTINGS,
        ...record.value,
      };
    }
  } catch (err) {
    console.error('Failed to read settings:', err);
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Save settings to meta table and apply immediately
 */
export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await db.meta.put({
    key: SETTINGS_KEY,
    value: settings,
  });
  applySettingsToDOM(settings);
}
