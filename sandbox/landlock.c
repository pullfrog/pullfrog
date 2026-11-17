// pullfrog-landlock: run a command confined to the paths it is given, for runners with no namespace
// sandbox. build.sh compiles it into the static binaries beside this file; see
// wiki/security.md "Path sandbox".
//
//   pullfrog-landlock [--ro PATH]... [--rw PATH]... -- COMMAND [ARG]...
//   pullfrog-landlock --probe
//
// --ro grants read and execute beneath PATH, --rw every filesystem right; anything else is refused.
// a missing PATH grants nothing. exits 126 when the sandbox cannot be applied, so a caller can tell
// that from the command's own failure. --probe applies the whole sandbox to itself and exits 0.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

// the rights each ABI added, by bit, so this builds against any kernel's headers
#define FS_ABI1 ((1ULL << 13) - 1) // execute .. make_sym
#define FS_REFER (1ULL << 13)      // abi 2
#define FS_TRUNCATE (1ULL << 14)   // abi 3
#define FS_IOCTL_DEV (1ULL << 15)  // abi 5
#define FS_FILE_RIGHTS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)
#define FS_READ (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) // abi 6
#define SCOPE_SIGNAL (1ULL << 1)               // abi 6

#if defined(__x86_64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_NATIVE AUDIT_ARCH_AARCH64
#else
#error "unsupported architecture"
#endif

struct ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

static int fail(const char *what) {
  fprintf(stderr, "pullfrog-landlock: %s: %s\n", what, strerror(errno));
  return 126;
}

static int add_path(int ruleset, const char *path, uint64_t rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT || errno == ENOTDIR ? 0 : -1;
  struct stat st;
  if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode)) rights &= FS_FILE_RIGHTS;
  struct landlock_path_beneath_attr attr = {.allowed_access = rights, .parent_fd = fd};
  int rc = syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
  close(fd);
  return rc;
}

// landlock does not mediate connect() on a pathname unix socket, and docker.sock is one, so the
// command gets no unix socket at all. io_uring creates sockets without socket(2), and on x86_64 the
// x32 numbers would slip past the checks below.
static int deny_unix_sockets(void) {
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_NATIVE, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 4, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 3, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 3),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}

int main(int argc, char **argv) {
  int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) return fail("landlock unavailable");
  struct ruleset_attr attr = {.handled_access_fs = FS_ABI1};
  size_t attr_size = sizeof(attr.handled_access_fs);
  if (abi >= 2) attr.handled_access_fs |= FS_REFER;
  if (abi >= 3) attr.handled_access_fs |= FS_TRUNCATE;
  if (abi >= 5) attr.handled_access_fs |= FS_IOCTL_DEV;
  if (abi >= 6) {
    attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL;
    attr_size = sizeof(attr);
  }
  int ruleset = syscall(__NR_landlock_create_ruleset, &attr, attr_size, 0);
  if (ruleset < 0) return fail("create_ruleset");

  int probe = argc == 2 && !strcmp(argv[1], "--probe");
  int i = 1;
  for (; !probe && i < argc && strcmp(argv[i], "--"); i += 2) {
    uint64_t rights;
    if (!strcmp(argv[i], "--ro")) rights = FS_READ;
    else if (!strcmp(argv[i], "--rw")) rights = attr.handled_access_fs;
    else return errno = EINVAL, fail(argv[i]);
    if (i + 1 >= argc) return errno = EINVAL, fail(argv[i]);
    if (add_path(ruleset, argv[i + 1], rights)) return fail(argv[i + 1]);
  }
  if (!probe && i + 1 >= argc) return errno = EINVAL, fail("no command");

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return fail("no_new_privs");
  if (deny_unix_sockets()) return fail("seccomp");
  if (syscall(__NR_landlock_restrict_self, ruleset, 0)) return fail("restrict_self");
  close(ruleset);
  if (probe) return 0;
  execvp(argv[i + 1], argv + i + 1);
  return fail(argv[i + 1]);
}
