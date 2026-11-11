import os
import json
import random
import threading
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit, join_room

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
HISTORY_FILE = os.path.join(BASE_DIR, 'ai_history.json')

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=STATIC_DIR)
app.config['SECRET_KEY'] = 'rps_secret_key_secure_99'
socketio = SocketIO(app, cors_allowed_origins="*")

rooms = {}
pvp_waiting_queue = {'3': [], '5': [], '999': []}
match_timers = {}

MAX_HISTORY = 30

def load_ai_history():
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, 'r') as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []

def save_ai_history(history):
    try:
        with open(HISTORY_FILE, 'w') as f:
            json.dump(history[-MAX_HISTORY:], f, indent=4)
    except Exception as e:
        print(f"Error saving AI history: {e}")

@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')

def get_ai_move():
    round_history = load_ai_history()
    prediction_scores = {'rock': 0.0, 'paper': 0.0, 'scissor': 0.0}
    
    if len(round_history) < 2:
        return random.choice(['rock', 'paper', 'scissor'])

    user_moves_only = [r['move'] for r in round_history]
    history_len = len(round_history)

    freq_counts = {'rock': 1, 'paper': 1, 'scissor': 1}
    for move in user_moves_only:
        if move in freq_counts:
            freq_counts[move] += 1
    for move in freq_counts:
        prediction_scores[move] += freq_counts[move] * 0.5

    max_pattern_length = min(8, history_len // 2)
    for length in range(max_pattern_length, 1, -1):
        current_pattern = user_moves_only[-length:]
        for i in range(history_len - length):
            historic_sub = user_moves_only[i:i + length]
            if current_pattern == historic_sub:
                next_move = user_moves_only[i + length]
                if next_move in prediction_scores:
                    prediction_scores[next_move] += (length * 2.0)

    decision_tree = {
        'rock':     {'win': {'rock':1, 'paper':1, 'scissor':1}, 'loss': {'rock':1, 'paper':1, 'scissor':1}, 'draw': {'rock':1, 'paper':1, 'scissor':1}},
        'paper':    {'win': {'rock':1, 'paper':1, 'scissor':1}, 'loss': {'rock':1, 'paper':1, 'scissor':1}, 'draw': {'rock':1, 'paper':1, 'scissor':1}},
        'scissor':  {'win': {'rock':1, 'paper':1, 'scissor':1}, 'loss': {'rock':1, 'paper':1, 'scissor':1}, 'draw': {'rock':1, 'paper':1, 'scissor':1}}
    }

    for i in range(history_len - 1):
        curr_round = round_history[i]
        next_round = round_history[i + 1]
        m = curr_round['move']
        o = curr_round['outcome']
        nxt = next_round['move']
        if m in decision_tree and o in decision_tree[m] and nxt in decision_tree[m][o]:
            decision_tree[m][o][nxt] += 2  

    last_round = round_history[-1]
    last_move = last_round['move']
    last_outcome = last_round['outcome']

    if last_move in decision_tree and last_outcome in decision_tree[last_move]:
        tree_scores = decision_tree[last_move][last_outcome]
        for move in tree_scores:
            prediction_scores[move] += (tree_scores[move] * 5.0)

    predicted_user_move = max(prediction_scores, key=lambda k: prediction_scores[k])
    return get_winning_move(predicted_user_move)

def get_winning_move(user_move):
    if user_move == 'rock':
        return 'paper'
    elif user_move == 'paper':
        return 'scissor'
    return 'rock'

def determine_outcome(move1, move2):
    if move1 == move2:
        return 'draw'
    if (move1 == 'rock' and move2 == 'scissor') or \
       (move1 == 'paper' and move2 == 'rock') or \
       (move1 == 'scissor' and move2 == 'paper'):
        return 'p1_win'
    return 'p2_win'

def record_round_history(user_move, ai_move, outcome_str):
    history = load_ai_history()
    history.append({
        'move': user_move,
        'ai_move': ai_move,
        'outcome': outcome_str
    })
    if len(history) > MAX_HISTORY:
        history = history[-MAX_HISTORY:]
    save_ai_history(history)

@socketio.on('join_game')
def handle_join(data):
    game_mode = data.get('gameMode', 'computer') 
    round_mode = data.get('roundMode', '3')     
    player_sid = request.sid #type: ignore
    
    if game_mode in ['computer', 'adaptive_ai']:
        room_id = f"single_{player_sid}"
        join_room(room_id)
        rooms[room_id] = {
            'game_mode': game_mode,
            'round_mode': round_mode,
            'p1_id': player_sid,
            'p2_id': 'AI',
            'p1_move': None,
            'p2_move': None,
            'p1_wins': 0,
            'p2_wins': 0,
            'draws': 0,
            'rounds_played': 0
        }
        emit('game_joined', {'status': 'success', 'room': room_id, 'role': 'p1', 'opponent': 'ai'}, to=player_sid)
        
    elif game_mode == 'pvp':
        queue = pvp_waiting_queue.get(round_mode, pvp_waiting_queue['3'])
        
        if len(queue) > 0:
            p1_sid = queue.pop(0)
            room_id = f"pvp_{p1_sid}_{player_sid}"
            
            if p1_sid in match_timers:
                try:
                    match_timers[p1_sid].cancel()
                except Exception:
                    pass
                del match_timers[p1_sid]
                
            join_room(room_id, sid=p1_sid)
            join_room(room_id, sid=player_sid)
            
            rooms[room_id] = {
                'game_mode': 'pvp',
                'round_mode': round_mode,
                'p1_id': p1_sid,
                'p2_id': player_sid,
                'p1_move': None,
                'p2_move': None,
                'p1_wins': 0,
                'p2_wins': 0,
                'draws': 0,
                'rounds_played': 0
            }
            
            emit('game_joined', {'status': 'success', 'room': room_id, 'role': 'p1', 'opponent': 'human'}, to=p1_sid)
            emit('game_joined', {'status': 'success', 'room': room_id, 'role': 'p2', 'opponent': 'human'}, to=player_sid)
            
        else:
            queue.append(player_sid)
            emit('waiting_for_opponent', {'status': 'waiting', 'duration': 120}, to=player_sid)
            
            def pvp_timeout(sid, mode):
                try:
                    q = pvp_waiting_queue.get(mode)
                    if q and sid in q:
                        q.remove(sid)
                        socketio.emit('matchmaking_failed', {'message': 'Failed to find another player.'}, to=sid)
                except Exception:
                    pass
                    
            t = threading.Timer(120.0, pvp_timeout, args=[player_sid, round_mode])
            match_timers[player_sid] = t
            t.start()

@socketio.on('submit_move')
def handle_submit_move(data):
    room_id = data.get('room')
    player_id = data.get('playerId') 
    move = data.get('move')         
    
    if not room_id or room_id not in rooms:
        return
    
    room = rooms[room_id]
    game_mode = room['game_mode']

    if game_mode in ['computer', 'adaptive_ai']:
        ai_move = 'rock'
        if game_mode == 'computer':
            ai_move = random.choice(['rock', 'paper', 'scissor'])
        elif game_mode == 'adaptive_ai':
            ai_move = get_ai_move()
            
        outcome = determine_outcome(move, ai_move)
        
        outcome_tree = 'draw'
        if outcome == 'p1_win':
            outcome_tree = 'win'
            room['p1_wins'] += 1
        elif outcome == 'p2_win':
            outcome_tree = 'loss'
            room['p2_wins'] += 1
        else:
            room['draws'] += 1
            
        room['rounds_played'] += 1
        
        if game_mode == 'adaptive_ai':
            record_round_history(move, ai_move, outcome_tree)
            
        is_game_over = check_match_completion(room)

        emit('resolve_round', {
            'p1_move': move,
            'p2_move': ai_move,
            'outcome': outcome,
            'scores': {
                'p1_wins': room['p1_wins'],
                'p2_wins': room['p2_wins'],
                'draws': room['draws']
            },
            'isGameOver': is_game_over
        }, to=room_id)

    elif game_mode == 'pvp':
        if player_id == 'p1':
            room['p1_move'] = move
            if room['p2_move'] is None and room.get('p2_id'):
                emit('opponent_moved', {'by': 'p1'}, to=room['p2_id'])
        else:
            room['p2_move'] = move
            if room['p1_move'] is None and room.get('p1_id'):
                emit('opponent_moved', {'by': 'p2'}, to=room['p1_id'])

        if room['p1_move'] and room['p2_move']:
            resolve_pvp_round(room_id)

def resolve_pvp_round(room_id):
    if room_id not in rooms:
        return
    room = rooms[room_id]
    m1 = room['p1_move']
    m2 = room['p2_move']
    
    outcome = determine_outcome(m1, m2)
    if outcome == 'p1_win':
        room['p1_wins'] += 1
    elif outcome == 'p2_win':
        room['p2_wins'] += 1
    else:
        room['draws'] += 1
        
    room['rounds_played'] += 1
    is_game_over = check_match_completion(room)

    socketio.emit('resolve_round', {
        'p1_move': m1,
        'p2_move': m2,
        'outcome': outcome,
        'scores': {
            'p1_wins': room['p1_wins'],
            'p2_wins': room['p2_wins'],
            'draws': room['draws']
        },
        'isGameOver': is_game_over
    }, to=room_id)

    room['p1_move'] = None
    room['p2_move'] = None

def check_match_completion(room):
    mode = room['round_mode']
    p1 = room['p1_wins']
    p2 = room['p2_wins']
    
    if mode == '3': 
        if p1 >= 2 or p2 >= 2 or room['rounds_played'] >= 3:
            return True
    elif mode == '5': 
        if p1 >= 3 or p2 >= 3 or room['rounds_played'] >= 5:
            return True
    return False 

@socketio.on('quit_game')
def handle_quit(data):
    room_id = data.get('room')
    if room_id and room_id in rooms:
        room = rooms[room_id]
        try:
            socketio.emit('show_scorecard', {
                'p1_wins': room.get('p1_wins', 0),
                'p2_wins': room.get('p2_wins', 0),
                'draws': room.get('draws', 0),
                'reason': 'quit'
            }, to=room_id)
        except Exception:
            pass
        del rooms[room_id]

def cleanup_player_session(player_sid):
    """Centralized, fault-tolerant teardown utility for any disconnecting socket session."""
    try:
        for mode in pvp_waiting_queue:
            if player_sid in pvp_waiting_queue[mode]:
                pvp_waiting_queue[mode].remove(player_sid)
        
        if player_sid in match_timers:
            try:
                match_timers[player_sid].cancel()
            except Exception:
                pass
            del match_timers[player_sid]
            
        rooms_to_delete = []
        for room_id, room in rooms.items():
            if room.get('p1_id') == player_sid or room.get('p2_id') == player_sid:
                try:
                    socketio.emit('show_scorecard', {
                        'p1_wins': room.get('p1_wins', 0),
                        'p2_wins': room.get('p2_wins', 0),
                        'draws': room.get('draws', 0),
                        'reason': 'disconnect'
                    }, to=room_id)
                except Exception:
                    pass
                rooms_to_delete.append(room_id)
                
        for r_id in rooms_to_delete:
            if r_id in rooms:
                del rooms[r_id]
    except Exception as e:
        print(f"Session cleanup warning for {player_sid}: {e}")

@socketio.on('disconnect')
def handle_disconnect():
    player_sid = request.sid #type: ignore
    cleanup_player_session(player_sid)
    
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
