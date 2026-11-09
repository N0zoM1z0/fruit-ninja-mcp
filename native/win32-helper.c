/*
 * Fruit Ninja Windows transport: process memory is read-only; native window focus uses Win32.
 * Build: i686-w64-mingw32-gcc -std=c11 -O2 -Wall -Wextra -Werror \
 *          native/win32-helper.c -o .local/windows/toolchain/win32-helper.exe
 *
 * One ASCII request per line, one JSON reply per line:
 *   attach [FruitNinja.exe] | info | regions | read ADDRESS LENGTH
 *   focus | snapshot       | close
 * ADDRESS accepts decimal or 0x hexadecimal. LENGTH is decimal, 1..65536.
 * No target function calls, injection, memory writes, or target termination.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <errno.h>
#include <io.h>
#include <fcntl.h>
#include <limits.h>

#define READ_LIMIT 65536U
#define REGION_LIMIT 4096U
#define ADDRESS_LIMIT UINT64_C(0x80000000)

static HANDLE target = NULL;
static DWORD target_pid = 0;
static FILETIME target_created;
static char target_name[MAX_PATH];

static void json_string(const char *value) {
    const unsigned char *p = (const unsigned char *)value;
    putchar('"');
    while (*p) {
        if (*p == '"' || *p == '\\') printf("\\%c", *p);
        else if (*p < 0x20 || *p >= 0x80) printf("\\u%04x", (unsigned)*p);
        else putchar(*p);
        p++;
    }
    putchar('"');
}

static void error_reply(const char *error, DWORD code) {
    fputs("{\"ok\":false,\"error\":", stdout);
    json_string(error);
    printf(",\"win32_error\":%lu}\n", (unsigned long)code);
}

static int live_target(void) {
    FILETIME created, exited, kernel, user;
    if (!target || WaitForSingleObject(target, 0) != WAIT_TIMEOUT) return 0;
    if (!GetProcessTimes(target, &created, &exited, &kernel, &user)) return 0;
    return CompareFileTime(&created, &target_created) == 0;
}

static int require_target(void) {
    if (live_target()) return 1;
    error_reply(target ? "target-exited" : "not-attached", 0);
    return 0;
}

typedef struct {
    HWND hwnd;
    uint64_t area;
} WindowSelection;

static BOOL CALLBACK select_window(HWND hwnd, LPARAM parameter) {
    WindowSelection *selection = (WindowSelection *)parameter;
    DWORD pid = 0;
    RECT rect;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != target_pid || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER))
        return TRUE;
    if (!GetClientRect(hwnd, &rect)) return TRUE;
    if (rect.right <= rect.left || rect.bottom <= rect.top) return TRUE;
    uint64_t area = (uint64_t)(rect.right - rect.left) *
                    (uint64_t)(rect.bottom - rect.top);
    if (area > selection->area) {
        selection->area = area;
        selection->hwnd = hwnd;
    }
    return TRUE;
}

static HWND target_window(void) {
    WindowSelection selection = {NULL, 0};
    EnumWindows(select_window, (LPARAM)&selection);
    return selection.hwnd;
}

static int client_bounds(HWND hwnd, RECT *rect, POINT *origin) {
    origin->x = 0;
    origin->y = 0;
    return hwnd && GetClientRect(hwnd, rect) && ClientToScreen(hwnd, origin);
}

static void print_info(void) {
    RECT rect;
    POINT origin;
    int alive = live_target();
    HWND hwnd = alive ? target_window() : NULL;
    ULARGE_INTEGER created;
    created.LowPart = target_created.dwLowDateTime;
    created.HighPart = target_created.dwHighDateTime;
    printf("{\"ok\":true,\"attached\":%s,\"alive\":%s,\"pid\":%lu,"
           "\"created_filetime\":\"%" PRIu64 "\",\"exe\":",
           target ? "true" : "false", alive ? "true" : "false",
           (unsigned long)target_pid, (uint64_t)created.QuadPart);
    json_string(target_name);
    if (client_bounds(hwnd, &rect, &origin)) {
        printf(",\"window\":{\"hwnd\":\"0x%" PRIxPTR "\","
               "\"left\":%ld,\"top\":%ld,\"width\":%ld,\"height\":%ld}",
               (uintptr_t)hwnd, origin.x, origin.y,
               rect.right - rect.left, rect.bottom - rect.top);
    } else fputs(",\"window\":null", stdout);
    fputs(",\"native_snapshot\":true}\n", stdout);
}

/* Read one bounded, REA-layout snapshot within the helper, avoiding hundreds
 * of pipe round trips. These are only ReadProcessMemory calls; never suspend
 * or write to the game. Recheck list descriptors before publishing anything. */
typedef struct { uint32_t address, length; unsigned char bytes[0x18c]; } Span;
static Span *snapshot_spans;
static unsigned snapshot_count;
static unsigned char *snapshot_read(uint32_t address, unsigned length) {
    SIZE_T count=0;
    if(address<0x10000 || address>=ADDRESS_LIMIT || length>ADDRESS_LIMIT-address || length>0x18c || snapshot_count>=2048) return NULL;
    Span *span=&snapshot_spans[snapshot_count];
    if(!ReadProcessMemory(target,(LPCVOID)(uintptr_t)address,span->bytes,length,&count)||count!=length)return NULL;
    span->address=address;span->length=length;snapshot_count++;
    return span->bytes;
}
static uint32_t word_at(const unsigned char *bytes,unsigned offset) {
    uint32_t value;memcpy(&value,bytes+offset,4);return value;
}
static void print_snapshot(void) {
    if(!require_target())return;
    snapshot_count=0;snapshot_spans=calloc(2048,sizeof(Span));
    if(!snapshot_spans){error_reply("snapshot-allocation-failed",0);return;}
    const char *error="Native entity snapshot changed";
    FILETIME stamp;ULARGE_INTEGER time_value;GetSystemTimeAsFileTime(&stamp);time_value.LowPart=stamp.dwLowDateTime;time_value.HighPart=stamp.dwHighDateTime;
    uint64_t captured_epoch_ms=time_value.QuadPart/10000-UINT64_C(11644473600000);
    unsigned char *globals=snapshot_read(0x5b3070,0x174);
    unsigned char *ticks=snapshot_read(0x5b3210,4);
    unsigned char *root_bytes=snapshot_read(0x5c0b00,4);
    if(!globals||!ticks||!root_bytes)goto failed;
    uint32_t camera=word_at(globals,0x4c);
    if(camera&&!snapshot_read(camera,0x174))goto failed;
    unsigned char *metadata=snapshot_read(0x5b2adc,4);
    if(!metadata)goto failed;
    uint32_t fruit_metadata=word_at(metadata,0);
    uint32_t config=word_at(globals,0x50),root=word_at(root_bytes,0);
    if(config&&!snapshot_read(config+0x104,4))goto failed;
    if(root<0x10000){error="Native entity manager is not ready";goto failed;}
    unsigned char *descriptors=snapshot_read(root,24);
    if(!descriptors)goto failed;
    for(unsigned group=0;group<2;group++){
        uint32_t sentinel=word_at(descriptors,group*12),count=word_at(descriptors,group*12+4);
        if(count>256)goto failed;
        unsigned char *head=snapshot_read(sentinel,4);
        if(!head)goto failed;
        uint32_t node=word_at(head,0);
        for(unsigned i=0;i<count;i++){
            if(node==sentinel)goto failed;
            unsigned char *links=snapshot_read(node,12);
            if(!links)goto failed;
            uint32_t entity=word_at(links,8);node=word_at(links,0);
            unsigned char *bytes=snapshot_read(entity,group?0xb0:0x18c);
            if(!bytes)goto failed;
            if(group==0&&fruit_metadata&&!snapshot_read(fruit_metadata+bytes[0x3c]*0x338+0x314,0x20))goto failed;
            uint32_t collider=word_at(bytes,0x38);
            if(collider&&!snapshot_read(collider+0x14,4))goto failed;
        }
        if(node!=sentinel)goto failed;
    }
    unsigned char after[24];SIZE_T count;
    if(!ReadProcessMemory(target,(LPCVOID)(uintptr_t)root,after,24,&count)||count!=24||memcmp(after,descriptors,24))goto failed;
    printf("{\"ok\":true,\"captured_epoch_ms\":%" PRIu64 ",\"spans\":[",captured_epoch_ms);
    for(unsigned i=0;i<snapshot_count;i++){
        Span *span=&snapshot_spans[i];
        if(i)putchar(',');
        printf("{\"address\":%lu,\"hex\":\"",(unsigned long)span->address);
        for(unsigned j=0;j<span->length;j++)printf("%02x",(unsigned)span->bytes[j]);
        fputs("\"}",stdout);
    }
    fputs("]}\n",stdout);free(snapshot_spans);snapshot_spans=NULL;return;
failed:
    free(snapshot_spans);snapshot_spans=NULL;error_reply(error,GetLastError());
}

static void attach_target(const char *name) {
    PROCESSENTRY32 entry;
    DWORD found_pid = 0;
    unsigned matches = 0;
    HANDLE snapshot;
    HANDLE new_target;
    FILETIME created, exited, kernel, user;
    if (!name || !*name) name = "FruitNinja.exe";
    if (strlen(name) >= MAX_PATH || strchr(name, '/') || strchr(name, '\\')) {
        error_reply("expected-executable-basename", 0);
        return;
    }
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        error_reply("process-snapshot-failed", GetLastError());
        return;
    }
    memset(&entry, 0, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (Process32First(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID != GetCurrentProcessId() &&
                _stricmp(entry.szExeFile, name) == 0) {
                found_pid = entry.th32ProcessID;
                matches++;
            }
        } while (Process32Next(snapshot, &entry));
    }
    CloseHandle(snapshot);
    if (matches != 1) {
        error_reply(matches ? "ambiguous-target" : "target-not-found", 0);
        return;
    }
    new_target = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION |
                             SYNCHRONIZE, FALSE, found_pid);
    if (!new_target) {
        error_reply("open-process-failed", GetLastError());
        return;
    }
    if (!GetProcessTimes(new_target, &created, &exited, &kernel, &user)) {
        DWORD code = GetLastError();
        CloseHandle(new_target);
        error_reply("process-identity-failed", code);
        return;
    }
    if (target) CloseHandle(target);
    target = new_target;
    target_pid = found_pid;
    target_created = created;
    memcpy(target_name, name, strlen(name) + 1);
    print_info();
}

static int parse_unsigned(const char *text, uint64_t *value) {
    char *end;
    unsigned long long parsed;
    if (!text || !*text || *text == '-' || *text == '+') return 0;
    errno = 0;
    parsed = strtoull(text, &end,
                     text[0] == '0' && (text[1] == 'x' || text[1] == 'X') ? 16 : 10);
    if (errno || *end) return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static void read_memory(const char *address_text, const char *length_text) {
    uint64_t address, length;
    unsigned char bytes[READ_LIMIT];
    SIZE_T count = 0;
    if (!parse_unsigned(address_text, &address) ||
        !parse_unsigned(length_text, &length) || !length || length > READ_LIMIT ||
        address >= ADDRESS_LIMIT || length > ADDRESS_LIMIT - address) {
        error_reply("invalid-read-range", 0);
        return;
    }
    if (!require_target()) return;
    if (!ReadProcessMemory(target, (LPCVOID)(uintptr_t)address,
                           bytes, (SIZE_T)length, &count) || count != length) {
        DWORD code = GetLastError();
        printf("{\"ok\":false,\"error\":\"read-failed\","
               "\"win32_error\":%lu,\"bytes_read\":%lu}\n",
               (unsigned long)code, (unsigned long)count);
        return;
    }
    printf("{\"ok\":true,\"address\":\"0x%" PRIx64 "\",\"length\":%lu,\"hex\":\"",
           address, (unsigned long)count);
    for (SIZE_T i = 0; i < count; i++) printf("%02x", (unsigned)bytes[i]);
    fputs("\"}\n", stdout);
}

static int readable_protection(DWORD protection) {
    if (protection & (PAGE_GUARD | PAGE_NOACCESS)) return 0;
    switch (protection & 0xff) {
    case PAGE_READONLY:
    case PAGE_READWRITE:
    case PAGE_WRITECOPY:
    case PAGE_EXECUTE_READ:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
        return 1;
    default:
        return 0;
    }
}

static void print_regions(void) {
    uint64_t address = 0, total = 0;
    SYSTEM_INFO system_info;
    uint64_t effective_limit;
    unsigned count = 0;
    int truncated = 0;
    DWORD query_error = 0;
    if (!require_target()) return;
    GetSystemInfo(&system_info);
    effective_limit = (uint64_t)(uintptr_t)system_info.lpMaximumApplicationAddress + 1;
    if (effective_limit > ADDRESS_LIMIT) effective_limit = ADDRESS_LIMIT;
    fputs("{\"ok\":true,\"regions\":[", stdout);
    while (address < effective_limit) {
        MEMORY_BASIC_INFORMATION info;
        SIZE_T result = VirtualQueryEx(target, (LPCVOID)(uintptr_t)address,
                                      &info, sizeof(info));
        if (!result) {
            query_error = GetLastError();
            truncated = 1;
            break;
        }
        uint64_t base = (uintptr_t)info.BaseAddress;
        uint64_t end = base + info.RegionSize;
        if (end > effective_limit) end = effective_limit;
        if (end <= address) {
            truncated = 1;
            break;
        }
        if (info.State == MEM_COMMIT && readable_protection(info.Protect)) {
            if (count == REGION_LIMIT) {
                truncated = 1;
                break;
            }
            if (count++) putchar(',');
            printf("{\"base\":\"0x%" PRIx64 "\",\"size\":%" PRIu64
                   ",\"type\":%lu,\"protect\":%lu}",
                   base, end - base, (unsigned long)info.Type,
                   (unsigned long)info.Protect);
            total += end - base;
        }
        address = end;
    }
    printf("],\"count\":%u,\"total_bytes\":%" PRIu64
           ",\"truncated\":%s,\"query_error\":%lu,"
           "\"address_limit\":\"0x80000000\",\"effective_address_limit\":\"0x%" PRIx64 "\"}\n",
           count, total, truncated ? "true" : "false", (unsigned long)query_error,
           effective_limit);
}

static HWND focused_target_window(void) {
    HWND hwnd = target_window();
    if (!hwnd) {
        error_reply("target-window-not-found", 0);
        return NULL;
    }
    if (GetForegroundWindow() != hwnd) SetForegroundWindow(hwnd);
    if (GetForegroundWindow() != hwnd) {
        error_reply("target-window-not-foreground", GetLastError());
        return NULL;
    }
    return hwnd;
}

int main(void) {
    char line[1024];
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, NULL, _IOFBF, 65536);
    SetProcessDPIAware();
    while (fgets(line, sizeof(line), stdin)) {
        char *tokens[6];
        unsigned count = 0;
        if (!strchr(line, '\n') && !feof(stdin)) {
            int ch;
            do { ch = getchar(); } while (ch != '\n' && ch != EOF);
            error_reply("request-too-long", 0);
            fflush(stdout);
            continue;
        }
        char *token = strtok(line, " \t\r\n");
        while (token && count < 6) {
            tokens[count++] = token;
            token = strtok(NULL, " \t\r\n");
        }
        if (!count) {
            error_reply("empty-request", 0);
        } else if (!strcmp(tokens[0], "attach") && count <= 2) {
            attach_target(count == 2 ? tokens[1] : NULL);
        } else if (!strcmp(tokens[0], "info") && count == 1) {
            print_info();
        } else if (!strcmp(tokens[0], "focus") && count == 1) {
            if (require_target() && focused_target_window())
                fputs("{\"ok\":true,\"focused\":true}\n", stdout);
        } else if (!strcmp(tokens[0], "regions") && count == 1) {
            print_regions();
        } else if (!strcmp(tokens[0], "read") && count == 3) {
            read_memory(tokens[1], tokens[2]);
        } else if (!strcmp(tokens[0], "snapshot") && count == 1) {
            print_snapshot();
        } else if (!strcmp(tokens[0], "close") && count == 1) {
            fputs("{\"ok\":true,\"closed\":true}\n", stdout);
            fflush(stdout);break;
        } else error_reply("invalid-request", 0);
        fflush(stdout);
    }
    if (target) CloseHandle(target);
    return 0;
}
