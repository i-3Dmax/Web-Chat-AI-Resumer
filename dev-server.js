// Локальный dev-сервер для Tampermonkey.
// Отдаёт wcair.user.js по http://localhost:3000/wcair.user.js,
// чтобы Tampermonkey тянул обновления с диска без ручного копирования.
//
// Запуск:   node dev-server.js
// Порт:     3000 (можно изменить через переменную окружения PORT)
//
// В Tampermonkey у скрипта уже заданы @updateURL/@downloadURL на этот адрес.
// После правки файла -> в Tampermonkey "Проверить обновления" (или вкладка
// Обновления -> Обновить) подтянет новую версию.

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;
var FILE = path.join(__dirname, 'wcair.user.js');

var server = http.createServer(function(req, res) {
  // Разрешаем запросы с любой страницы (Tampermonkey шлёт с web.max.ru / vk.ru)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Requested-With'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  var url = req.url.split('?')[0];

  if (url === '/wcair.user.js') {
    fs.readFile(FILE, 'utf8', function(err, data) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Ошибка чтения файла: ' + err.message);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>WCAIR - Web Chat AI Resumer: dev-сервер работает</h1>' +
      '<p>Скрипт: <a href="/wcair.user.js">/wcair.user.js</a></p>' +
      '<p>Версия на диске сейчас: ' + getVersion(FILE) + '</p>'
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404: ' + url);
});

function getVersion(file) {
  try {
    var text = fs.readFileSync(file, 'utf8');
    var m = text.match(/@version\s+([\w.\-]+)/);
    return m ? m[1] : 'не найден';
  } catch (e) {
    return 'ошибка чтения';
  }
}

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.log(
      'Порт ' + PORT + ' уже занят — похоже, dev-сервер уже запущен.\n' +
      'Проверьте: http://localhost:' + PORT + '/wcair.user.js'
    );
    process.exit(0);
  }

  throw err;
});

server.listen(PORT, function() {
  console.log('WCAIR dev-сервер запущен: http://localhost:' + PORT + '/wcair.user.js');
  console.log('Версия на диске: ' + getVersion(FILE));
});
