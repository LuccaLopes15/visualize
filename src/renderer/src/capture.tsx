import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capture } from './capture/Capture'
import './styles/tokens.css'
import './capture/capture.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Capture />
  </StrictMode>
)
