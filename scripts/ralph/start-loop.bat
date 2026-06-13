@echo off
REM Launch the GradeThread Ralph loop boxed into its own half of the host so it
REM can coexist with a second agent loop without starving it. See
REM docs\AGENT_COHABITATION.md for the full contract.
REM
REM This box: 24 logical cores / 31 GB RAM.
REM   GradeThread  -> logical cores 0-11   (affinity FFF)
REM   Other loop   -> logical cores 12-23  (affinity FFF000)
REM /belownormal keeps the machine usable; the heap cap stops a build ballooning.
REM
REM Usage:  scripts\ralph\start-loop.bat [iterations]   (default 200)

setlocal
set ITERS=%1
if "%ITERS%"=="" set ITERS=200

set NODE_OPTIONS=--max-old-space-size=3072

start "RalphGT" /belownormal /affinity FFF cmd /c "npm run ralph -- %ITERS%"

echo Started GradeThread Ralph (cores 0-11, belownormal, %ITERS% iterations).
echo To start the OTHER loop in its lane, run in ITS repo:
echo   set NODE_OPTIONS=--max-old-space-size=3072
echo   start "RalphOther" /belownormal /affinity FFF000 cmd /c "<that loop's command>"
endlocal
