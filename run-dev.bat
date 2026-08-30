@echo off
REM Запуск локального dev-сервера для Tampermonkey.
REM Просто запустите этот файл, чтобы поднять сервер (или узнать, что он уже работает).
cd /d "%~dp0"
node dev-server.js
pause
