import { render } from '@solidjs/web'
import App from './App'
import './styles.css'
import './paper.css'

const root = document.getElementById('app')
if (!root) throw new Error('element #app introuvable')
render(() => App(), root)
