// 站点可编辑配置：版本号与交流群。交流群建好后，在 groups 里加一项即可显示在「社区」区块。
// name / note 是简体中文；nameEn / noteEn、nameJa / noteJa 供右上角语言切换使用。
window.TSUMIGEYA_SITE = {
  version: 'v3.1.4',
  groups: [
    {
      name: 'QQ 交流群', nameEn: 'QQ Group', nameJa: 'QQ グループ',
      platform: 'QQ GROUP', id: '1134670666', qr: './assets/img/qq-group-qr.png',
      note: '使用交流、兼容性反馈，用 QQ 扫码加入。',
      noteEn: 'Usage chat and compatibility reports — scan the code with QQ to join.',
      noteJa: '使い方の相談と互換性の報告。QQ で読み取って参加してください。',
    },
    {
      name: 'Discord 社区', nameEn: 'Discord community', nameJa: 'Discord コミュニティ',
      platform: 'DISCORD', url: 'https://discord.gg/kqut5fAnyk',
      note: '兼容性反馈、游戏安利与日常交流，点击加入。',
      noteEn: 'Compatibility reports, game recommendations and daily chat — click to join.',
      noteJa: '互換性の報告、ゲームの紹介、日々の雑談。クリックで参加できます。',
    },
  ],
};
