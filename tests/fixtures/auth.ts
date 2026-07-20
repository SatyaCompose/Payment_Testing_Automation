import * as path from 'path';

export const AUTH_FILE = path.resolve(__dirname, '..', '.auth', 'user.json');

export const authCredentials = () => ({
  email: process.env.TEST_USER_EMAIL ?? '',
  password: process.env.TEST_USER_PASSWORD ?? '',
});
