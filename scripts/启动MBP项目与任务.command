#!/bin/sh
# 双击启动 MBP 的现有 Candidate 3 测试环境，打开项目与任务页面。
# 前台运行；Ctrl+C 停止。登录 token 只交给本机 Chrome。
set -eu

MBP_DSH_ROOT='/Users/pmp/AI/deepseek-harness/test-env/dsh-task-management-candidate-3-ece68974'
if [ ! -x "$MBP_DSH_ROOT/bin/start-web-settings.sh" ]; then
  echo '启动失败：找不到 MBP 测试环境的启动脚本。' >&2
  exit 1
fi
if [ ! -d '/Applications/Google Chrome.app' ]; then
  echo '启动失败：未找到 Google Chrome。' >&2
  exit 1
fi

echo '启动 MBP DSH 项目与任务：http://127.0.0.1:3082/#tasks'
echo '沿用现有 executor 配置与数据库。是否接收远端任务由插件配置的暂停开关决定。'
echo '请保留此终端；按 Ctrl+C 停止服务。'

exec /usr/bin/python3 -u - "$MBP_DSH_ROOT" <<'PY'
import re
import signal
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit, urlunsplit

root = sys.argv[1]
child = subprocess.Popen(
    [root + '/bin/start-web-settings.sh', '--approved-create-web-auth', '--chrome-handoff'],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1,
)
opened = False

def hide_login_url(match):
    url = urlsplit(match.group(0))
    return urlunsplit((url.scheme, url.netloc, url.path, '', '')) + (' [登录参数已隐藏]' if url.query else '')

def stop_child():
    if child.poll() is None:
        child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=5)

try:
    for line in child.stdout:
        clean = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', line)
        if clean.startswith('dsh web: http'):
            launch_url = clean[len('dsh web: '):].split()[0]
            url = urlsplit(launch_url)
            query = parse_qs(url.query)
            if (url.scheme != 'http' or url.netloc != '127.0.0.1:3082' or url.path != '/'
                    or set(query) != {'token'} or len(query['token']) != 1 or not query['token'][0]
                    or url.fragment):
                raise RuntimeError('官方登录地址与本机测试环境不匹配；已停止。')
            if not opened:
                task_url = urlunsplit((url.scheme, url.netloc, url.path, url.query, 'tasks'))
                result = subprocess.run(
                    ['/usr/bin/open', '-a', '/Applications/Google Chrome.app', task_url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                if result.returncode:
                    raise RuntimeError('无法打开 Chrome；已停止。')
                opened = True
                print('已在 Chrome 打开项目与任务。远端接单开关：插件 → task-system → 配置。')
            continue
        sys.stdout.write(re.sub(r'https?://[^\s\x1b]+', hide_login_url, clean))
        sys.stdout.flush()
    status = child.wait()
    if status == 0 and not opened:
        print('DSH 已退出；未收到官方 Web 登录地址。')
    sys.exit(status if status >= 0 else 128 - status)
except KeyboardInterrupt:
    stop_child()
    print('\nMBP DSH 已停止。')
    sys.exit(130)
except RuntimeError as error:
    stop_child()
    print(str(error), file=sys.stderr)
    sys.exit(1)
PY
