import { resolve } from 'node:path'
import { defineConfig } from 'wxt'

export default defineConfig({
  outDirTemplate: '../dist{{modeSuffix}}',
  watchOptions: { ignored: ['**/dist/**', '**/dist-dev/**'] },
  hooks: {
    'build:publicAssets'(wxt, files) {
      files.push({ absoluteSrc: resolve(wxt.config.root, 'LICENSE'), relativeDest: 'LICENSE' })
    },
  },
  manifest: {
    name: 'Network Chaos',
    description: 'Simulate WebRTC packet loss in one Chrome tab. Test how a video call recovers and how your app behaves offline.',
    minimum_chrome_version: '118',
    permissions: ['debugger', 'storage'],
    action: { default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  },
  vite: () => ({ build: { target: 'chrome118' } }),
})
