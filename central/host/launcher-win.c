// Build on Windows with MSVC: cl /O2 /Fe:launcher.exe central\host\launcher-win.c
// The resulting native executable starts the bundled Node runtime with inherited stdio.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>

int wmain(int argc, wchar_t **argv) {
  wchar_t self[MAX_PATH], root[MAX_PATH], node[MAX_PATH], script[MAX_PATH];
  if (!GetModuleFileNameW(NULL, self, MAX_PATH)) return 1;
  wchar_t *slash = wcsrchr(self, L'\\');
  if (!slash) return 1;
  *slash = 0;
  wcscpy_s(root, MAX_PATH, self);
  swprintf_s(node, MAX_PATH, L"%ls\\runtime\\node.exe", root);
  swprintf_s(script, MAX_PATH, L"%ls\\central\\host\\main.mjs", root);
  // Chromium may also pass --parent-window on Windows. Never forward it to Node.
  if (argc < 2 || argc > 3 || wcsncmp(argv[1], L"chrome-extension://", 19) != 0 ||
      (argc == 3 && wcsncmp(argv[2], L"--parent-window=", 16) != 0)) return 1;
  wchar_t command[3 * MAX_PATH];
  swprintf_s(command, 3 * MAX_PATH, L"\"%ls\" \"%ls\" \"%ls\"", node, script, argv[1]);
  STARTUPINFOW startup = {0};
  PROCESS_INFORMATION child = {0};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  if (!CreateProcessW(node, command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, root, &startup, &child)) return 1;
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hThread);
  CloseHandle(child.hProcess);
  return (int)code;
}
