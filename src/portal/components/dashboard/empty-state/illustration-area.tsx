"use client"

import { Cloud, Shield, Database, Settings, GitCompare } from "lucide-react"
import { GradientOrb } from "./gradient-orbs"

export function IllustrationArea() {
  return (
    <div className="relative h-48 md:h-64 rounded-2xl bg-gradient-to-b from-gray-50 to-white border border-gray-100 overflow-hidden animate-in slide-in-from-bottom duration-700 delay-100">
      {/* Gradient orbs */}
      <GradientOrb
        size="md"
        gradient="from-purple-400 to-pink-400"
        position="top-0 right-0 -translate-y-1/3 translate-x-1/3"
        opacity={25}
      />
      <GradientOrb
        size="md"
        gradient="from-blue-400 to-cyan-400"
        position="bottom-0 left-0 translate-y-1/3 -translate-x-1/3"
        opacity={25}
      />
      <GradientOrb
        size="sm"
        gradient="from-orange-400 to-red-400"
        position="top-1/4 left-1/2 -translate-x-1/2"
        opacity={20}
      />
      
      {/* Central icon composition */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative">
          {/* Main central icon */}
          <div className="relative z-10 w-28 h-28 md:w-36 md:h-36 rounded-2xl bg-white shadow-2xl flex items-center justify-center animate-in zoom-in duration-700 delay-300">
            <Cloud className="w-14 h-14 md:w-20 md:h-20 text-blue-600" />
          </div>
          
          {/* Floating satellite icons */}
          <div className="absolute -top-12 -left-20 w-14 h-14 rounded-xl bg-white shadow-lg flex items-center justify-center animate-float" style={{ animationDelay: "0s" }}>
            <Shield className="w-7 h-7 text-green-600" />
          </div>
          <div className="absolute -top-12 -right-20 w-14 h-14 rounded-xl bg-white shadow-lg flex items-center justify-center animate-float" style={{ animationDelay: "2s" }}>
            <Database className="w-7 h-7 text-purple-600" />
          </div>
          <div className="absolute -bottom-12 -left-24 w-14 h-14 rounded-xl bg-white shadow-lg flex items-center justify-center animate-float" style={{ animationDelay: "4s" }}>
            <Settings className="w-7 h-7 text-orange-600" />
          </div>
          <div className="absolute -bottom-12 -right-24 w-14 h-14 rounded-xl bg-white shadow-lg flex items-center justify-center animate-float" style={{ animationDelay: "6s" }}>
            <GitCompare className="w-7 h-7 text-pink-600" />
          </div>
          
        </div>
      </div>
      
      {/* Subtle grid pattern */}
      <div 
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: `linear-gradient(to right, #6B7280 1px, transparent 1px), linear-gradient(to bottom, #6B7280 1px, transparent 1px)`,
          backgroundSize: '50px 50px'
        }}
      />
    </div>
  )
}