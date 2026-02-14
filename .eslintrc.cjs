module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  ignorePatterns: ["node_modules/", "logs/", "uploads/", "coverage/"],
  extends: ["eslint:recommended"],
  rules: {
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  },
};
