// Port of cmd/opencodereview/version.go.

export const VERSION = '0.0.1-dev';
export const GIT_COMMIT = '';
export const BUILD_DATE = '';

export function printVersion(): void {
  let line = `open-code-review ${VERSION}`;
  if (GIT_COMMIT) line += ` (${GIT_COMMIT})`;
  line += ` ${process.platform}/${process.arch}`;
  console.log(line);
  if (BUILD_DATE) console.log(`built at: ${BUILD_DATE}`);
  console.log('https://github.com/SmaLLAlien/ocr');
}
