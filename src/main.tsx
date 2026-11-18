import React from 'react'
import ReactDOM from 'react-dom/client'
import { Router } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'
import { App } from './app'
import { TipHost } from './components/tip'
import { TooltipProvider } from './components/ui/tooltip'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      {/* hash 路由：桌面版加载的还是同一个页面，浏览器里刷新停在原处 */}
      <Router hook={useHashLocation}>
        <App />
      </Router>
      <TipHost />
    </TooltipProvider>
  </React.StrictMode>,
)
