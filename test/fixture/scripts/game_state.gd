extends Node
## Autoloaded singleton tracking simple cross-scene state.

var score: int = 0
var last_health: int = 100


func reset() -> void:
	score = 0
	last_health = 100
