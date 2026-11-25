'use strict';
// 서버·관리자·공개 화면(오프라인 카드 포함)이 쓰는 같은 허용 목록. 네트워크 호출 없음.
(function () {
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const base = value.trim().split(/[?#]/, 1)[0];
    const m = /^https:\/\/www\.instagram\.com\/(p|reel)\/([A-Za-z0-9_-]{1,128})\/?$/.exec(base);
    if (!m || m[0] !== base) return null;
    return `https://www.instagram.com/${m[1]}/${m[2]}/`;
  }
  if (typeof module === 'object' && module.exports) module.exports = {normalize};
  else window.CarelinkInstagram = Object.freeze({normalize});
})();
