/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "test",
  testRegex: ".*\\.e2e-spec\\.ts$",
  moduleFileExtensions: ["js", "json", "ts"],
};
