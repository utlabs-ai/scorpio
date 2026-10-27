#include <stdio.h>
#include <stdlib.h>

/* A local input recorder, named claude so Herdr can recognize an agent without a subscription. */
int main(void) {
  FILE *file = fopen(getenv("HERDR_INPUT_FILE"), "a");
  if (!file) return 1;
  printf("Claude Code local input recorder\n❯ ");
  fflush(stdout);
  char *line = NULL;
  size_t size = 0;
  ssize_t length;
  while ((length = getline(&line, &size, stdin)) >= 0) {
    fwrite(line, 1, length, file);
    fflush(file);
    printf("❯ ");
    fflush(stdout);
  }
  free(line);
  fclose(file);
  return 0;
}
