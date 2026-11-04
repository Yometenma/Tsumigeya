// hash 路由：生产走 file://，必须用 createWebHashHistory（§4 router.ts）。
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/library' },
  { path: '/library', name: 'library', component: () => import('./pages/LibraryPage.vue') },
  // 新建走三步向导（AddGameWizard）
  { path: '/library/new', name: 'library-new', component: () => import('./components/AddGameWizard.vue') },
  // M2.6 §5.3：路由拆分（原来的 `/game/:id` 是编辑页，现在语义变了）
  //   /game/:id       → **详情页**（新）：唯一的启动入口 + 完整元数据（D38）
  //   /game/:id/edit  → 编辑页（原 `:id` 那条，加了 /edit 后缀）
  // 段数不同，两条不会互相误匹配；顺序只是为了读起来清楚。
  { path: '/game/:id', name: 'game-detail', component: () => import('./pages/GameDetailPage.vue'), props: true },
  { path: '/game/:id/edit', name: 'game-edit', component: () => import('./pages/GameEditPage.vue'), props: true },
  { path: '/engines', name: 'engines', component: () => import('./pages/EnginesPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/library' }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
