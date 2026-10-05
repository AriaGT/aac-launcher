import type { LauncherBridge } from '../preload';

declare global {
  interface Window {
    launcher: LauncherBridge;
  }
}

export {};