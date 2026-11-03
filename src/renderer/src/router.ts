// hash 路由：生产走 file://，必须用 createWebHashHistory（§4 router.ts）。
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/library' },
  { path: '/library', name: 'library', component: () => import('./pages/LibraryPage.vue') },
  // 新建走三步向导（AddGameWizard），编辑走 GameEditPage
  { path: '/library/new', name: 'library-new', component: () => import('./components/AddGameWizard.vue') },
  { path: '/game/:id', name: 'game-edit', component: () => import('./pages/GameEditPage.vue'), props: true },
  { path: '/engines', name: 'engines', component: () => import('./pages/EnginesPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/library' }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
