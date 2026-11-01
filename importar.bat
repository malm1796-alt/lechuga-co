@echo off
title Lechuga ^& Co. - Importar productos
cd /d C:\LechugaCo
node server\importar.js
echo.
set /p R=  Cargar estos productos? (S/N):
if /i "%R%"=="S" node server\importar.js --aplicar
pause
