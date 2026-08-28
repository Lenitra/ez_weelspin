@echo off
rem Genere builds\weelspin.html (fichier unique) et weelspin-dist.zip (contenu de src\)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
