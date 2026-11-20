import { defineConfig } from 'wxt'

export default defineConfig({
  outDirTemplate: '../dist{{modeSuffix}}',
  watchOptions: { ignored: ['**/dist/**', '**/dist-dev/**'] },
  manifest: {
    name: 'Network Chaos',
    description: 'Test how a tab responds to Chrome DevTools packet loss and offline conditions.',
    minimum_chrome_version: '118',
    permissions: ['activeTab', 'debugger', 'storage'],
    action: { default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  },
  vite: () => ({ build: { target: 'chrome118' } }),
})
