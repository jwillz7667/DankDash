//
//  Item.swift
//  DankDash
//
//  Created by Justin Williams on 5/17/26.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
