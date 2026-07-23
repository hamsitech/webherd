#include <unistd.h>

int main(void) {
  execl("/usr/bin/open", "open", "http://webherd.test", (char *)0);

  return 1;
}
