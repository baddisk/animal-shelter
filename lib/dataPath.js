'use strict';
const path = require('node:path');

// T2 전용. Render에서는 실제 Persistent Disk의 마운트 경로를 DATA_DIR로 설정한다.
// 기존 통계·케어 기록의 위치를 암묵적으로 변경하거나 마이그레이션하지 않는다.
const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
module.exports = (...parts) => path.join(root, ...parts);
