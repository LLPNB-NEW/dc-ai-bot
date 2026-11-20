-- 0025: 语音回复再加一层「导演模式」：0 = 关（逐字朗读），1 = 只许插标签，2 = 允许顺句改写。
-- DEFAULT 0 让已有行直接就是「关」，旧库升级不用回填；脏值由读侧 normalize 落回 0，所以不加 CHECK。
ALTER TABLE voice_settings ADD COLUMN director INTEGER NOT NULL DEFAULT 0;
