const bcrypt = require('bcrypt');
const apiKey = 'mk_live_abcd1234567890efghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
const hash = await bcrypt.hash(apiKey, 12);
console.log(hash);