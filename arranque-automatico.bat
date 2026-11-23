@echo off
rem Arranca todo Lechuga & Co. al prender la PC (lo lanza el acceso directo de la carpeta Inicio de Windows).
rem Si el servidor se cae, se vuelve a levantar solo a los 5 segundos.
title Lechuga ^& Co. - Servidor (no cerrar)
cd /d C:\LechugaCo
set NODE="C:\Program Files\nodejs\node.exe"

rem Espera a que haya internet antes de abrir el tunel.
timeout /t 20 /nobreak >nul

start "Lechuga & Co. - Tunel de internet (no cerrar)" /min %NODE% server\tunel.js

:servidor
%NODE% server\server.js
echo El servidor se detuvo. Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto servidor
