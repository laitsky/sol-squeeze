import app from './app.js'
import { getEnv, parsePositiveInt } from './app.js'

const port = parsePositiveInt(getEnv('PORT'), 8787, 1, 65535)
app.listen(port, () => {
  console.log(`[server] Sol Squeeze API listening on http://localhost:${port}`)
})
