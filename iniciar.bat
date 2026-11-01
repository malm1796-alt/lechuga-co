@echo off
title Lechuga ^& Co. - Servidor
cd /d C:\LechugaCo
if not exist node_modules\@anthropic-ai\sdk call npm install --no-fund --no-audit
node server\setup.js --si-falta
start "Lechuga & Co. - Tunel de internet" /min node server\tunel.js
start "" http://localhost:8787/caja/
node server\server.js
pause
